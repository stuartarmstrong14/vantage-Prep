# 145 Prepped (Vantage prep tracker)

A web app for tracking used cars through preparation, with a username and password login for each member of staff.

- **Staff** can add cars, tick off prep and sign off QC with their initials.
- **Advisors** can look at progress but cannot change anything. This is the role for sales advisors who scan QR stickers.
- **Administrators** can also delete cars and add, deactivate or reset staff logins.
- Everyone sees changes from other people within about 8 seconds.

## QR stickers

Every car can have a QR sticker for the dashboard.

1. Add the car. In its sheet, press **Print QR sticker**. To print several, use **Print QR stickers** above the stock list; it prints whatever cars the current filter shows.
2. Choose **Single label** (100 × 70 mm), **A4 sheet** (8 per page, with cutting lines) **Small label** (50 × 30 mm, QR code, registration and tag only) or **A4 landscape notice** (one car per page, sized to sit inside the 28 × 17 cm window of an A4 price board, laid out symmetrically: large centred Vantage logo, AWAITING PREP heading, a large QR code marked "Staff: scan for prep progress", registration, model and tag; set the print window to Landscape), then Print.
3. Stick it on the dashboard and tick **QR sticker fitted** on the car's Inbound checklist.
4. An advisor scans it with their phone camera. They sign in (their login is remembered on their phone) and the car opens showing its stage and every completed step.

The sticker shows the registration, model and tag number only. The progress itself is behind the login, so a customer who scans it sees a sign-in screen and nothing else.

**Set `PUBLIC_URL` before printing** (see below). The QR code contains the web address of this app. If you print while using the app at `http://localhost:3000`, the codes will only work on that computer. The sticker page warns you when this is the case.

If a sticker is damaged, print it again from the same car. The code never changes, so old and new stickers both work.

It needs **Node.js 22.13 or newer** and nothing else. There are no packages to install.

## Try it on your own computer

```
npm start
```

Open http://localhost:3000. The first time, you are asked to create the administrator account. After that, use **Account > Manage staff logins** to add everyone else.

## Quick test deploy (Render)

1. Put this folder in a GitHub repository (private is fine).
2. On render.com choose **New > Blueprint**, pick the repository, and apply. It reads `render.yaml`.
3. When it is live, copy its web address into the `PUBLIC_URL` setting (Render shows it as `https://vantage-prep-xxxx.onrender.com`) and redeploy, so QR codes use it.
4. Open the address straight away and create the administrator account. Whoever opens it first becomes the administrator.

The free plan sleeps when idle and **wipes the data on every restart**. It is for testing only. For real use, add a disk and set `DATA_DIR`, as described below.

## Put it on the internet for your team

You need somewhere that runs a Node.js app (or a Docker container) **and keeps a permanent disk**. The database lives in the `data` folder, so on a host that wipes its disk on every restart you would lose your cars and logins.

1. Upload this folder (or build the included `Dockerfile`).
2. Start command: `npm start` (or let Docker run it).
3. Mount a persistent disk or volume and point `DATA_DIR` at it. The Dockerfile uses `/data`.
4. Serve it over **HTTPS**. Most hosts do this for you. Passwords are not safe over plain http.
5. Set `TRUST_PROXY=1` if the host puts a proxy in front of the app (nearly all do; the Dockerfile sets it).

Typical choices are a small VPS, Fly.io, Railway or Render with a disk attached.

## Adding cars by email

Send an email to a dedicated address and each car in it is added at **Inbound**, so nobody types it in twice. Use one car per group of lines, in this order. Price, TAC and service lines are ignored:

```
AYGO X
YB19CYZ
TAG-184
TAC
SERVICE
MOT
MILEAGE- 58552
PRICE – 8690
```

- Several cars can go in one email. Blank lines between lines are fine.
- The make is filled in when it is written before the model (Toyota Aygo X) or the model is a common one (Aygo, Golf, Fiesta). Otherwise it is left blank for staff to complete.
- **Prep requested:** the TAC, SERVICE and MOT lines in the email are shown as coloured tags on the car (for example `TAC, SERVICE` or `TAC ONLY`). Staff can switch them on or off in the car sheet. This replaces the old Colour box.
- If the MOT line has a date (for example `MOT 12/03/2027`), that date is used.
- A registration already in stock is skipped, so forwarding the same email twice is safe.
- New cars show "Last updated by Email" and a note asking staff to check the details.

Set up:

1. Set `INBOUND_SECRET` to a long random string, and `INBOUND_ALLOWED` to the email addresses allowed to send, for example `sam@yourdomain.co.uk`.
2. Use an inbound-email service (Postmark inbound is the simplest) with an address such as `prep@yourdomain.co.uk`, and point its webhook at `https://your-app-address/api/inbound?key=YOUR_SECRET`.
3. Send yourself a test email and check the car appears.

The endpoint accepts Postmark, Mailgun and SendGrid style posts, or a plain JSON `{ "from": "...", "text": "..." }` from tools such as Zapier or Make. The sender check relies on the From header, so the secret in the web address is what keeps the endpoint private. Do not share it.

## Settings (environment variables)

| Name | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where the database is kept |
| `PUBLIC_URL` | the address you are browsing | The live web address staff use, for example `https://prep.yourdomain.co.uk`. Put into every QR code |
| `TZ_NAME` | `Europe/London` | Time zone used for "arrived" and sign-off dates |
| `TRUST_PROXY` | off | Set to `1` behind a proxy so sign-in limits use the real visitor address |
| `SESSION_SECRET` | made for you | Optional. Signs login cookies. By default one is created in the data folder |
| `COOKIE_SECURE` | auto | Set to `1` to force the secure cookie flag |
| `INBOUND_SECRET` | off | Turns on adding cars by email. The key the email service puts on the web address |
| `INBOUND_ALLOWED` | anyone | Comma-separated sender addresses allowed to add cars by email |
| `DVLA_API_KEY` | off | Turns on the registration lookup (make, colour, MOT expiry) from the DVLA Vehicle Enquiry Service |
| `MOT_CLIENT_ID`, `MOT_CLIENT_SECRET`, `MOT_API_KEY`, `MOT_TOKEN_URL` | off | Optional DVSA MOT History API credentials: adds the model and the latest MOT result. `MOT_TOKEN_URL` is the full token URL from DVSA's email |

## Looking after it

- **Backup:** an administrator taps **Account -> Download backup** to save a full copy of the database (cars, history, logins and uploaded 145 point checks) as `145prepped-backup-<date>.db`. Do this weekly and keep copies off the server, for example on a work drive. The file contains staff password hashes, so store it somewhere private. On the server, `npm run backup` also saves a copy to `data/backups`. To restore, replace `prep.db` in the data folder with a backup file while the app is stopped.
- **Forgotten administrator password:** `npm run reset-password -- username NewPassword123`
- **Leavers:** deactivate them under Manage staff logins. They are signed out straight away and their past sign-offs stay on record. Once deactivated, **Delete login** removes the login for good (it asks you to tap twice). Past sign-offs keep the person's name, because the name is stored on the car.

## What is built in

- Passwords are stored hashed (scrypt), never in plain text.
- Login cookies are HttpOnly and SameSite, and are Secure over https.
- Eight wrong attempts in 15 minutes locks that username on that device for 15 minutes.
- Changing or resetting a password, or deactivating someone, signs them out everywhere.
- QC sign-offs record the initials, the date and the logged-in person's name, taken by the server.

## 145 point mechanical checks

On the Mechanical stage, the **145 point mechanical check** row is an upload box instead of a tick box. Staff upload the completed check (a PDF or a photo: JPEG, PNG, WebP or HEIC, up to 15 MB each, up to 10 files per car). The row then shows **Completed ✓** with the file name, and the stage progress updates automatically. Staff can add more files or remove one (tap Remove twice to confirm); removing the last file puts the row back to "Needs upload". Advisors can view the files but not upload or remove them. Cars ticked before this feature existed show "Ticked before uploads were added".

Administrators can find any check from the **145 point checks** search at the bottom of **Reports** by typing a registration (spaces and capitals don't matter). Nothing is listed until you type.

Uploaded PDFs over 150 KB are made smaller automatically with Ghostscript (images re-saved at 150 dpi, still easy to read and print); if that fails or doesn't help, the original is kept as uploaded. Data health shows whether PDF shrinking is on and how much it has saved. Files are stored inside the database, so they live on the Render disk (`/data`), are included in `npm run backup`, and use disk space. Keep an eye on the 1 GB disk if you upload a lot of large PDFs. Deleting a car deletes its check files.

## Keeping 145 point checks safe

- **Your data is only on the Render disk** (`/data`). GitHub holds the code, never the data, so pushing an update replaces code only. Never remove the disk or change its mount path.
- **Automatic backups:** every time the app starts (which happens on every update) and once a day, it saves a full copy of the database to `/data/backups`. It keeps the newest 14, fewer if the disk gets more than 75% full.
- **Recycle bin:** removing a 145 check, or deleting a car, keeps its check files for 30 days. The app logs who removed what.
- **Data health** (Account -> Data health and recovery, administrators): shows how many checks are stored and attached, lists any check that is stored but not showing on its car (**Reattach to their cars**), lists cars ticked without a file, shows the recycle bin (**Restore**), the automatic backups, and lets you **recover checks from a downloaded backup**. Recovery only adds missing checks back to the same car, matched by registration; nothing else is changed or rolled back.
- **Safety test before every update:** `npm test` uploads checks and runs overlapping saves, a lost link, a removal and restore, a restart and a recovery from backup, and fails if any check goes missing. Run it before pushing.
- **Saves no longer overwrite each other:** the server reads a car only after an upload or change has fully arrived, so a slow upload and someone ticking a box at the same moment can't undo each other.
- **Weekly:** an administrator should still use **Download backup** and keep the file off the server. Render also snapshots the disk daily for 7 days, but restoring a snapshot rolls back everything since, so try Data health first.

## Technician logins

Besides Staff, Advisor and Administrator, an administrator can give someone a technician login under Manage staff logins. Technicians see every car (read only) but can tick just their own job:

| Login | Can tick | Also |
| --- | --- | --- |
| Valet Technician | Valet completed, Photographs completed | |
| Paint Technician | Paint work completed | |
| Alloy Technician | Alloy wheels completed | Wheels to refine |
| Dent Technician | Dents completed | |

Their stock list opens on the cars still needing their job. The server enforces this, so nothing else can be changed from those logins, and the stage still moves on by itself when their tick finishes a stage.

## User guide

The user guide is at **/guide** (for example www.145prepped.co.uk/guide) and only opens for signed-in people; anyone else is sent to the sign-in page and then straight on to the guide. Open it from **Account -> Open the user guide**. It has a **Download PDF** button (/guide.pdf) and a link back to the app.

To change it, edit `guide/src/guide-src.html` (screenshots are in `guide/src/shots/`), then run `python3 guide/src/build.py` to rebuild `guide/guide.html` and `guide/guide.pdf` (needs Pillow and Playwright with Chromium) and commit both.

## Searching

The **Search** box on the home screen looks through every car: in prep, completed and archived. Type a registration (spaces don't matter), tag number, make or model and tap **Search** or press Enter. Each result is labelled In prep, Completed or Archived. Tap **Clear search**, a tab or a department box to go back.

## Department boxes

Under **How prep is going**, **Still to do, by department** shows a box for each department (Inbound, Valet, Photos, Mechanical, Bodywork, Quality Check). Each box shows how many cars in prep still need work from that department, whatever stage the car has reached: a car waiting at Valet with its mechanical boxes unticked counts under Mechanical too. Tapping **Bodywork** also opens **Bodywork jobs**, which counts cars still needing Dents, Alloy wheels and Paint; they stay hidden otherwise. Tapping an open job again goes back to the Bodywork list.

Tap a box to show only those cars in the stock list; tap it again (or **Show all**) to see everything. The **Quality Check** box counts only cars where everything else is ticked and the final quality check is still to do. A car moves to **Completed** once that last box is ticked. This replaces the old stage drop-down.

## Registration lookup and daily MOT check

When `DVLA_API_KEY` is set in Render, **Add car** shows a **Look up** button next to the registration (it also looks up automatically when you leave the box). It fills in make, colour and MOT expiry from the DVLA; with the DVSA MOT History keys it also fills in the model and notes the latest MOT result. Anything already typed is not overwritten.

Every morning (about 6am, and a few minutes after each restart) the app checks every car still in prep and updates its MOT expiry from the official record, so a new MOT shows up by itself. Make, model and colour are only filled in when empty, so staff edits are kept. Car cards show the MOT date, and the car sheet says when it was last checked. Tax status is not used. Data health shows whether the lookup is on and how the last daily check went.

To get keys: apply for a DVLA Vehicle Enquiry Service API key on the DVLA developer portal, and (optional) register for the DVSA MOT History API. Paste them into Render -> Environment, then save; Render restarts the app.

## Cosmetic estimate

Under the cosmetic notes on the Bodywork stage, staff build a **Cosmetic estimate** by picking repairs from the price list (with a quantity). The car shows each line and the total time and internal cost. The **Paint and cosmetic work** list in Reports shows each car's estimate and the total for all outstanding cosmetic work.

The price list comes from the cosmetic matrix spreadsheet (Area of Repair, Time in hours, Internal cost; "New Pannel" is spelled "New Panel"). Version 2 (5 Nov 2026) added Alloy Wheel; version 3 (5 Nov 2026) sets Alloy Wheel and Dent to 0 hrs at £35 each. Existing sites are upgraded automatically on the next start (once only, and only if those two lines haven't been edited), keeping estimates linked. Administrators change it under **Account -> Edit cosmetic price list**: edit names, hours and prices, add or remove repairs, then **Save price list**. The estimate also decides two Bodywork jobs. A **Dent** line means dents need doing (the Dents box shows how many); no Dent line ticks Dents completed as **Not needed**. Alloy lines (Alloy Wheel, Diamond Cut Alloy, Painted Alloy) set the wheels to refine and mean alloys need doing; none ticks Alloy wheels completed as **Not needed**. If a dent or alloy line is added later, or the estimate is cleared, the box goes back to a normal job. Every other line is cosmetic or paint work and appears in the Cosmetics list in Reports. At the bottom of Reports, **Cosmetic costs** sits beside the 145 point check search: with nothing typed it shows how many cars in prep have an estimate, the estimated total, and the amount still to do (paint not ticked); type a registration or tag to see that car's estimate line by line. Estimates always use the current prices. Staff and administrators see prices; technicians and advisors see the repairs and hours only.

## Cosmetic notes

Under **Cosmetic check complete** on the Bodywork stage there is a box for what cosmetic work needs doing (up to 1,000 characters). It saves as you type and everyone can see it; advisors see it read-only. The tick box still marks the cosmetic check as done.

## Cosmetic prep report

**Reports** (administrators) has an **Outstanding bodywork** card with two tabs, **Alloys** and **Cosmetics**, each showing how many cars are waiting. It sits at the bottom of Reports and is closed until you tap a tab. Each list is for cars still in prep and shows the tag number, registration and model; tapping a car opens it:

- **Alloy wheels to refine:** cars whose "Wheels to refine" number is above zero and whose alloy wheels aren't ticked yet, with a total number of wheels.
- **Paint and cosmetic work:** cars that have text in the cosmetic notes box and whose paint work isn't ticked yet, showing those notes. Cars whose notes mention paint, respray, spray, refinish or lacquer are listed first and marked "Paint".

The lists update as people tick things off.

## Update pop-ups

When someone else ticks off a prep item or adds a car, everyone else who has the app open sees a short pop-up at the top, for example "Paul updated Bodywork: Cosmetic check complete (AB21 CDE)". It appears within about 8 seconds, disappears after 7 seconds, and can be tapped away. You never get a pop-up for your own changes.

## Archiving

A car is archived automatically 30 days after it was completed (passed Quality Check), or once it has been on the system for more than 365 days (counted from the day it arrived), whichever comes first. Archived cars leave the In prep and Completed tabs and appear under **Archived**. Nothing is deleted, and archived cars are still included in every report. Staff can also archive a completed car at any time with the **Archive car** button in its sheet, and bring any archived car back with **Restore from archive**. Only an administrator can delete a car, using Delete car in its sheet.

## How the stage works

There is no stage dropdown. A car's stage follows its ticks: it is "at" the first area that is not fully ticked, and a green tick appears on each area as it is completed. Once Inbound, Valet, Photos, Mechanical and Bodywork are all ticked the car is at Quality Check, which counts as completed.

## Changing the checklist

The stages and tick boxes are listed at the top of `public/app.js` (`STAGES`). Edit the names there. Ticks are stored against the stage and item ids, so renaming a label keeps existing ticks, while removing an item hides its old ticks.

### Check MOT and MOT history

Next to **MOT expiry** on each car, **Check MOT** looks the car up straight away and fills in the expiry (and the colour if blank). With the DVSA MOT history keys it also saves the car's full MOT history: every test with its date, pass or fail, mileage, expiry and each advisory, minor, major or dangerous item. The history shows under the car details (collapsed when the car is opened, open after Check MOT); a mileage lower than the test before is shown in red. Histories are kept in their own table so the board stays quick, and are refreshed by the daily MOT check. Cars added by email are checked as soon as they arrive. If a check fails the button shows the reason, and **Data health** shows the last error.
