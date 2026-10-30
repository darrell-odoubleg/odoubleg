# Montana State Fair events (msf.odoubleg.com)

Node/Express + SQLite (better-sqlite3), pm2 name `msf-odoubleg`, 127.0.0.1:4400 behind nginx.

- `/` public daily schedule (phones) with a Map tab
- `/kiosk` auto-scrolling display for digital signs. URL options: `?location=<id>`, `?category=<id>`, `?speed=<px/s>`, `?theme=light`, `?day=YYYY-MM-DD`
- `/admin` add/edit events (one form can add a show on several days), locations (click the fairgrounds map or a Mist floor plan to place), settings
- Map tab: the printed fairgrounds map (`assets/fairgrounds-map.png`, x/y in image pixels, map id `fairgrounds`) comes first, then the Mist floor plans. Its 36 numbered spots plus the main areas were loaded with `node scripts/seed-fairgrounds.js` (safe to re-run). Directions / blue dot only work on Mist floor plans.
- `/download` the Android APK (`data/apk/msf.apk`)

County calendar: `server/countyFeed.js` imports the Cascade County ExpoPark iCal feed (Settings → County calendar) hourly as `source='county'` events, skipping anything titled Private Event (incl. typos like "PRVATE EVENT"). Imported events can't be edited, only hidden/featured/mapped; events the county removes are deleted on the next sync.

Styling uses the Montana ExpoPark logo colors (navy `#353653`, red `#e4332d`); the heading is the fair banner `public/msf-banner.jpg` (from MSF.png).

Floor plans come read-only from the Montana ExpoPark Mist org (`MIST_*` in `.env`), cached in `data/maps/`.

Admin logins: `node scripts/admin-user.js <username> "<Name>" [password]` (creates or resets).

## Android app (`android/`)

Kotlin WebView shell around the site, plus the Juniper Mist location SDK (`com.mist:core-sdk`) in `MistBridge.kt`,
exposed to the page as `window.MSFNative` (startLocation / stopLocation / route). The SDK secret is read at runtime
from `/api/app-config` (set it on the admin Settings tab), so it can change without a new build.

Build on this server:

    cd android
    ANDROID_HOME=/opt/android-sdk JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ./gradlew assembleRelease
    cp app/build/outputs/apk/release/app-release.apk ../data/apk/msf.apk

Bump `versionCode` in `app/build.gradle` for each release. Signing: `android/keystore.properties` → `/root/.android-keys/msf-release.jks`
(not in git; back it up — losing it means users must uninstall to update).
