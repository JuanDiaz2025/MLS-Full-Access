# Start the Voice queue — once, then leave it

Everything is built. Two things run on your machine; nothing else.

## 1. Chrome, signed in to Voice

Close Chrome, then start it with the debugging port open:

**Windows**
```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

**Mac**
```
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

In that window, open https://voice.google.com/u/0/messages and sign in yourself.
Leave the window open. Nothing in this repo ever sees your password or a code —
it attaches to the browser you signed in.

## 2. The queue watcher

```
git pull origin claude/keen-meitner-t4gora
cd rei
node gvqueue.js            # watch and PREVIEW — prints every message, sends nothing
node gvqueue.js --go       # watch and SEND
```

It watches `rei/queue/`. Drop a batch file in, it goes out. Preview leaves the
file in the queue, so you can look first and then start it with `--go`.

Point it at a synced folder and batches arrive on their own:
```
node gvqueue.js --go --dir "G:\My Drive\Twin Network\queue"
```

## To send the batch that is waiting now

Put `gv-ready.json` (the file I sent you) into `rei/queue/`, then run the
`--go` line above. Two agents:

- Scott Dancer, (650) 888-8199 — 115 Forest View Road, Woodside
- Thomas Rapisarda, (707) 592-2852 — 248 Santa Cruz Drive, Fairfield

I would drop Thomas: Fairfield is outside Juan's counties and "vacant" is the
whole case for that one. Delete his block from the file if you agree.

## Stopping it

```
touch rei/queue/STOP      # Windows: type nul > rei\queue\STOP
```
The text in flight finishes, then it stops.

## What it will not do

- Text anyone twice. Every send is logged and checked against both logs first.
- Send a half-written file. A batch is only picked up once it stops growing.
- Hide a failure. A batch that does not fully send moves to `queue/failed/`
  with the reason beside it, and the watcher carries on.
