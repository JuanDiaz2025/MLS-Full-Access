// The small WordPress plugin that saves every Contact Form 7 submission in the site's own database
// and hands them to the app when it asks with the right key. It also does the lead tracking by
// itself: it adds the UTM / click id hidden fields to every Contact Form 7 form and puts the
// tracking script on every page, so nothing has to be pasted into WordPress. WordPress is always online, so leads
// sent while this computer or the app is off are kept there until the app picks them up.
//
// The app builds the plugin with its key filled in; the Leads page offers it as a .zip to upload in
// WordPress (Plugins → Add New → Upload Plugin).
import { TRACKING_FIELDS, TRACKING_SNIPPET } from "@/lib/leads/wordpress-snippets"
import { zipFiles } from "@/lib/zip"

export const PLUGIN_VERSION = "1.3.0"
export const PLUGIN_FOLDER = "omcc-lead-saver"

const phpString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

export function wordpressPlugin(key: string) {
  return String.raw`<?php
/**
 * Plugin Name: One Marketing Command Center – Lead Saver
 * Description: Saves every Contact Form 7 submission on this site, so the One Marketing Command Center gets every lead, even ones sent while it was off.
 * Version: ${PLUGIN_VERSION}
 * Requires PHP: 7.0
 * Author: One Marketing Command Center
 */

if (!defined('ABSPATH')) {
	exit;
}

// The key the Command Center sends when it asks for leads. Keep it private.
define('OMCC_LEADS_KEY', ${phpString(key)});
define('OMCC_LEADS_VERSION', '${PLUGIN_VERSION}');
define('OMCC_LEADS_DB_VERSION', '1');

function omcc_leads_table() {
	global $wpdb;
	return $wpdb->prefix . 'omcc_leads';
}

// The table the leads are kept in: one row per form submission.
function omcc_leads_install() {
	global $wpdb;
	require_once ABSPATH . 'wp-admin/includes/upgrade.php';
	$table = omcc_leads_table();
	$charset = $wpdb->get_charset_collate();
	dbDelta("CREATE TABLE $table (
		id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
		received datetime NOT NULL,
		form varchar(200) NOT NULL DEFAULT '',
		fields longtext NOT NULL,
		PRIMARY KEY  (id)
	) $charset;");
	update_option('omcc_leads_db_version', OMCC_LEADS_DB_VERSION);
}
register_activation_hook(__FILE__, 'omcc_leads_install');
add_action('plugins_loaded', function () {
	if (get_option('omcc_leads_db_version') !== OMCC_LEADS_DB_VERSION) {
		omcc_leads_install();
	}
});

// Shortens text without cutting a letter like "é" in half (which the database would refuse).
function omcc_leads_cut($text, $length) {
	$text = function_exists('mb_substr') ? mb_substr((string) $text, 0, $length, 'UTF-8') : substr((string) $text, 0, $length);
	return wp_check_invalid_utf8($text, true);
}

function omcc_leads_text($value) {
	if (is_array($value)) {
		return implode(', ', array_filter(array_map('omcc_leads_text', $value), 'strlen'));
	}
	return is_scalar($value) ? omcc_leads_cut(trim((string) $value), 5000) : '';
}

// Lead tracking, built in: hidden fields on every Contact Form 7 form...
add_filter('wpcf7_form_hidden_fields', function ($fields) {
	$form = class_exists('WPCF7_ContactForm') ? WPCF7_ContactForm::get_current() : null;
	foreach (array(${TRACKING_FIELDS.map((f) => `'${f}'`).join(", ")}) as $name) {
		// Skip a field the form already has (e.g. its own [hidden utm_source]).
		if (isset($fields[$name]) || ($form && $form->scan_form_tags(array('name' => $name)))) {
			continue;
		}
		$fields[$name] = '';
	}
	return $fields;
});

// ...and the script that remembers where each visitor came from and fills them in.
add_action('wp_footer', function () {
	echo <<<'OMCC_TRACKING'
${TRACKING_SNIPPET}
OMCC_TRACKING;
	echo "\n";
});

// Saves a submission the moment Contact Form 7 accepts it (after its spam checks, before the
// email goes out, so a lead is kept even if the email fails).
add_action('wpcf7_before_send_mail', 'omcc_leads_save', 1, 3);
function omcc_leads_save($form, $abort = null, $submission = null) {
	omcc_leads_store($form, $submission, '');
}

// Every submission's outcome, after Contact Form 7 is done with it. Ones it turned away as spam
// (often reCAPTCHA wrongly blocking a real person) or that another plugin stopped are saved too,
// marked, so a real lead is never silently lost. Each outcome is also noted for the Leads page.
add_action('wpcf7_submit', 'omcc_leads_after_submit', 99, 2);
function omcc_leads_after_submit($form, $result) {
	$status = is_array($result) && isset($result['status']) ? (string) $result['status'] : '';
	$saved = !empty($GLOBALS['omcc_leads_saved']);
	if (!$saved && in_array($status, array('spam', 'aborted', 'mail_sent', 'mail_failed'), true)) {
		$saved = omcc_leads_store($form, null, in_array($status, array('spam', 'aborted'), true) ? $status : '');
	}
	omcc_leads_note($form, $status, $saved);
}

function omcc_leads_note($form, $status, $saved) {
	$events = get_option('omcc_leads_events');
	$events = is_array($events) ? $events : array();
	array_unshift($events, array(
		'at' => gmdate('Y-m-d\TH:i:s\Z'),
		'form' => is_object($form) && method_exists($form, 'title') ? omcc_leads_cut($form->title(), 100) : '',
		'status' => omcc_leads_cut($status, 40),
		'saved' => (bool) $saved,
	));
	update_option('omcc_leads_events', array_slice($events, 0, 20), false);
}

// Saves one submission. $flag is '' for a normal one, or 'spam' / 'aborted'.
function omcc_leads_store($form, $submission, $flag) {
	try {
		if (!$submission && class_exists('WPCF7_Submission')) {
			$submission = WPCF7_Submission::get_instance();
		}
		if (!$submission || !method_exists($submission, 'get_posted_data')) {
			return false;
		}
		$fields = array();
		foreach ((array) $submission->get_posted_data() as $name => $value) {
			$name = (string) $name;
			if (strpos($name, '_wpcf7') === 0 || strpos($name, 'g-recaptcha') === 0 || strpos($name, '_wp') === 0) {
				continue;
			}
			$text = omcc_leads_text($value);
			if ($text !== '') {
				$fields[$name] = $text;
			}
		}
		$title = is_object($form) && method_exists($form, 'title') ? (string) $form->title() : '';
		if ($title !== '' && !isset($fields['form_title'])) {
			$fields['form_title'] = $title;
		}
		$url = method_exists($submission, 'get_meta') ? $submission->get_meta('url') : '';
		if ($url && !isset($fields['page_url'])) {
			$fields['page_url'] = (string) $url;
		}
		if ($flag !== '') {
			$fields['_omcc_flag'] = $flag;
		}
		// Bad characters are replaced rather than losing the whole lead (that option needs PHP 7.2).
		$json = wp_json_encode($fields, defined('JSON_INVALID_UTF8_SUBSTITUTE') ? JSON_INVALID_UTF8_SUBSTITUTE : 0);
		global $wpdb;
		$ok = $wpdb->insert(
			omcc_leads_table(),
			array('received' => gmdate('Y-m-d H:i:s'), 'form' => omcc_leads_cut($title, 200), 'fields' => $json ? $json : '{}'),
			array('%s', '%s', '%s')
		);
		if ($ok === false) {
			error_log('Command Center Lead Saver could not save a lead: ' . $wpdb->last_error);
			return false;
		}
		$GLOBALS['omcc_leads_saved'] = true;
		return true;
	} catch (\Throwable $e) {
		error_log('Command Center Lead Saver could not save a lead: ' . $e->getMessage());
		return false;
	}
}

// GET /wp-json/omcc/v1/leads?after=<id>: the leads saved after that one, oldest first.
add_action('rest_api_init', function () {
	register_rest_route('omcc/v1', '/leads', array(
		'methods' => 'GET',
		'callback' => 'omcc_leads_list',
		'permission_callback' => '__return_true',
	));
});

function omcc_leads_list($request) {
	nocache_headers();
	$given = $request->get_header('x-omcc-key');
	if (!$given) {
		$given = $request->get_param('key');
	}
	if (!is_string($given) || !hash_equals(OMCC_LEADS_KEY, $given)) {
		return new WP_REST_Response(array('ok' => false, 'code' => 'omcc_bad_key', 'error' => 'Wrong or missing key.'), 403);
	}
	global $wpdb;
	$table = omcc_leads_table();
	$after = max(0, intval($request->get_param('after')));
	$rows = $wpdb->get_results($wpdb->prepare("SELECT id, received, form, fields FROM $table WHERE id > %d ORDER BY id ASC LIMIT 200", $after), ARRAY_A);
	if ($rows === null || $wpdb->last_error) {
		omcc_leads_install();
		return new WP_REST_Response(array('ok' => false, 'code' => 'omcc_no_table', 'error' => 'The plugin was still setting up. Try again.'), 500);
	}
	$leads = array();
	foreach ($rows as $row) {
		$fields = json_decode($row['fields'], true);
		$leads[] = array(
			'id' => intval($row['id']),
			'received' => str_replace(' ', 'T', $row['received']) . 'Z',
			'form' => $row['form'],
			'fields' => is_array($fields) ? $fields : new stdClass(),
		);
	}
	update_option('omcc_leads_last_pull', gmdate('Y-m-d H:i:s'), false);
	return new WP_REST_Response(array(
		'ok' => true,
		'plugin' => OMCC_LEADS_VERSION,
		'total' => intval($wpdb->get_var("SELECT COUNT(*) FROM $table")),
		'events' => is_array(get_option('omcc_leads_events')) ? get_option('omcc_leads_events') : array(),
		'leads' => $leads,
	), 200);
}

// A page in WordPress (Contact → Command Center leads) showing what's been saved, and when the
// Command Center last picked leads up.
add_action('admin_menu', function () {
	if (class_exists('WPCF7')) {
		add_submenu_page('wpcf7', 'Command Center leads', 'Command Center leads', 'manage_options', 'omcc-leads', 'omcc_leads_admin');
	} else {
		add_management_page('Command Center leads', 'Command Center leads', 'manage_options', 'omcc-leads', 'omcc_leads_admin');
	}
}, 20);

add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
	$page = class_exists('WPCF7') ? 'admin.php' : 'tools.php';
	array_unshift($links, '<a href="' . esc_url(admin_url($page . '?page=omcc-leads')) . '">Saved leads</a>');
	return $links;
});

function omcc_leads_pick($fields, $names) {
	foreach ($names as $name) {
		if (!empty($fields[$name])) {
			return $fields[$name];
		}
	}
	return '';
}

function omcc_leads_explain($status) {
	$map = array(
		'mail_sent' => 'Sent normally.',
		'mail_failed' => 'Accepted, but Contact Form 7 could not send its email (the lead is still saved).',
		'spam' => 'Blocked as spam by Contact Form 7 (usually reCAPTCHA). Saved anyway, so you can check it.',
		'aborted' => 'Stopped by another plugin before sending. Saved anyway.',
		'validation_failed' => 'Not sent: a required field was missing or wrong.',
		'acceptance_missing' => 'Not sent: the consent box wasn\'t ticked.',
	);
	return isset($map[$status]) ? $map[$status] : ($status !== '' ? $status : 'Unknown');
}

function omcc_leads_admin() {
	global $wpdb;
	$table = omcc_leads_table();
	$total = intval($wpdb->get_var("SELECT COUNT(*) FROM $table"));
	$rows = $wpdb->get_results("SELECT id, received, form, fields FROM $table ORDER BY id DESC LIMIT 25", ARRAY_A);
	$pull = get_option('omcc_leads_last_pull');
	$format = get_option('date_format') . ' ' . get_option('time_format');
	echo '<div class="wrap"><h1>Command Center leads</h1>';
	echo '<p>Every Contact Form 7 submission is saved here, and the One Marketing Command Center brings them in whenever it&rsquo;s open, so no lead is missed while it&rsquo;s off.</p>';
	echo '<p><strong>' . esc_html($total) . '</strong> lead' . ($total === 1 ? '' : 's') . ' saved. ';
	echo $pull
		? 'The Command Center last picked up leads on <strong>' . esc_html(get_date_from_gmt($pull, $format)) . '</strong>.'
		: '<strong>The Command Center hasn&rsquo;t connected yet.</strong> In the app, open Leads → Website leads and type in this site&rsquo;s address.';
	echo '</p>';
	if ($rows) {
		echo '<table class="widefat striped"><thead><tr><th>Received</th><th>Form</th><th>Name</th><th>Email</th><th>Phone</th><th>Status</th></tr></thead><tbody>';
		foreach ($rows as $row) {
			$f = json_decode($row['fields'], true);
			$f = is_array($f) ? $f : array();
			echo '<tr><td>' . esc_html(get_date_from_gmt($row['received'], $format)) . '</td>';
			echo '<td>' . esc_html($row['form']) . '</td>';
			echo '<td>' . esc_html(omcc_leads_pick($f, array('your-name', 'name', 'full-name', 'first-name'))) . '</td>';
			echo '<td>' . esc_html(omcc_leads_pick($f, array('your-email', 'email'))) . '</td>';
			echo '<td>' . esc_html(omcc_leads_pick($f, array('your-phone', 'your-tel', 'phone', 'tel'))) . '</td>';
			echo '<td>' . (!empty($f['_omcc_flag']) ? '<strong style="color:#b32d2e">Marked as ' . esc_html($f['_omcc_flag']) . ' by Contact Form 7</strong>' : 'OK') . '</td></tr>';
		}
		echo '</tbody></table>';
	} else {
		echo '<p>No leads saved yet. Send a test from your form and refresh this page.</p>';
	}
	$events = get_option('omcc_leads_events');
	echo '<h2>Recent form submissions</h2>';
	if (is_array($events) && $events) {
		echo '<table class="widefat striped"><thead><tr><th>When</th><th>Form</th><th>What happened</th><th>Saved here</th></tr></thead><tbody>';
		foreach ($events as $event) {
			echo '<tr><td>' . esc_html(get_date_from_gmt(str_replace(array('T', 'Z'), array(' ', ''), $event['at']), $format)) . '</td>';
			echo '<td>' . esc_html($event['form']) . '</td>';
			echo '<td>' . esc_html(omcc_leads_explain($event['status'])) . '</td>';
			echo '<td>' . ($event['saved'] ? 'Yes' : 'No') . '</td></tr>';
		}
		echo '</tbody></table>';
	} else {
		echo '<p>No form has been sent since this version of the plugin was installed.</p>';
	}
	echo '</div>';
}
`
}

// The plugin as a .zip WordPress can install (Plugins → Add New → Upload Plugin).
export function wordpressPluginZip(key: string) {
  return zipFiles([{ name: `${PLUGIN_FOLDER}/${PLUGIN_FOLDER}.php`, data: Buffer.from(wordpressPlugin(key), "utf8") }])
}
