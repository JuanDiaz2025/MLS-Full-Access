WhatsApp Reader 1.0.1
=====================

WhatsApp Reader links to your phone the same way WhatsApp Web does and saves
your WhatsApp GROUP messages on this computer, so the accountability
dashboard can read them through the Claude desktop app.

It only reads. It has no code for sending messages, reactions, read
receipts or "typing". One-to-one chats are never saved. Everything stays in
this folder on this computer.


SETUP (one time, about 15 minutes)
----------------------------------

1. Put this folder somewhere permanent, for example C:\WhatsAppReader
   (not Downloads). The saved messages live next to whatsapp-reader.exe.

2. Double-click whatsapp-reader.exe.
   - If Windows says "Windows protected your PC", click "More info", then
     "Run anyway". It shows this because the program isn't signed.
   - It asks how to link:
       * Press Enter for a QR code. On your phone: WhatsApp > Settings >
         Linked devices > Link a device, and point the camera at it.
       * Or type your phone number with country code (digits only, for
         example 15551234567) and press Enter. On your phone: WhatsApp >
         Settings > Linked devices > Link a device > Link with phone number
         instead, and type the 8-character code it shows.
   - Wait until it says "Done", then press Enter to close the window.

3. Add it to the Claude desktop app:
   - Open the Claude desktop app > Settings > Developer > Edit Config.
   - Paste this in (if the file already has "mcpServers", add just the
     "whatsapp-reader" part inside it), changing the path if your folder
     is somewhere else. Keep the double backslashes.

       {
         "mcpServers": {
           "whatsapp-reader": {
             "command": "C:\\WhatsAppReader\\whatsapp-reader.exe",
             "args": ["serve"]
           }
         }
       }

   - Save the file, then fully quit Claude (right-click its icon by the
     clock > Quit) and open it again.

4. Open the dashboard link INSIDE the Claude desktop app, signed in as the
   dashboard's owner.
   - Allow it to use WhatsApp Reader, and allow it to use Claude, when asked.
   - Pick your test group, check that your own number is ticked as the one
     giving instructions, and press "Start tracking".


TEST (with your friend)
-----------------------
You post four instructions in the test group. Your friend:
  1. replies normally to the first,
  2. swipes to quote-reply the second,
  3. reacts with a thumbs up to the third,
  4. ignores the fourth.
Then check the dashboard shows the first three as replied (with their
response times) and your friend as not responding to the fourth.
Also try one instruction that names your friend with a deadline
("Mike, send photos of the site by 5pm") and have them send a photo back.


IF YOUR PHONE SAYS "COULDN'T LINK DEVICE"
-----------------------------------------
1. Check the top of the window says WhatsApp Reader 1.0.1 or later.
   Version 1.0.0 stopped linking when WhatsApp offered its passkey step.
2. Try again, scanning the newest code on screen.
3. Try the 8-character code instead: double-click whatsapp-reader.exe,
   type your phone number and press Enter.
4. If your WhatsApp account has a passkey (WhatsApp > Settings > Account >
   Passkeys), WhatsApp may ask for it when linking, and WhatsApp Reader
   can't use passkeys. Removing the passkey there, linking, and adding it
   back afterwards gets around this.
5. Still stuck? Send reader.log from this folder. It lists each linking step.


GOOD TO KNOW
------------
- The reader runs while the Claude desktop app is open. Messages that
  arrive while it's closed are delivered when it reconnects.
- The dashboard is live only in the Claude desktop app on this computer.
  Each update is saved into the dashboard, so others with the link see the
  latest saved numbers on any device.
- WhatsApp's rules don't allow third-party linked devices, even ones that
  only read. The risk is low because nothing is ever sent, but it isn't zero.
- Problems? Look at reader.log in this folder.
- To check what's linked:   whatsapp-reader.exe status
- To unlink and delete all saved messages:   whatsapp-reader.exe unlink
  (or remove "WhatsApp Reader" on your phone under Linked devices).
