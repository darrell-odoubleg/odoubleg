# O Double G apps

Each folder is one app running on the O Double G VPS. The apps run from
their own directories on the server, each with its own local git repo;
this repo collects them with `git subtree`, keeping their history.

| Folder | Live at | Runs from | Process |
|---|---|---|---|
| `events/` | events.odoubleg.com | `/var/www/events-odoubleg` | systemd `events-odoubleg` |
| `mist/` | mist.odoubleg.com | `/var/www/mist-odoubleg` | pm2 `mist-odoubleg` |
| `sitenotes/` | sitenotes.odoubleg.com | `/var/www/sitenotes-odoubleg` | pm2 `sitenotes-odoubleg` |
| `stocks/` | stocks.odoubleg.com | `/var/www/stocks-odoubleg` | pm2 `stocks-odoubleg` |

Secrets (`.env`), databases and data caches are not committed — each app
has a `.env.example` listing the settings it needs.

## Updating this repo

Commit in the app's own directory, then on the server run
`/srv/odoubleg/sync.sh`, which pulls every app's new commits into its
folder and pushes to GitHub.
