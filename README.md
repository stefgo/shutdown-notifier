# Shutdown Notifier

Watches the shutdown schedule of a systemd host and reports to a webhook when a shutdown is
scheduled (`shutdown -h +10`, `shutdown -r 22:00`), shortly before it happens, and when it is
cancelled (`shutdown -c`).

The notification is a **JSON body you write yourself**, in a template file with placeholders
for the data of the event. The template language is the one of the
[Keepalived Status Monitor](https://github.com/stefgo/keepalived-status-monitor) webhooks.

## How it works

systemd-logind keeps a scheduled shutdown in `/run/systemd/shutdown/scheduled` and removes
the file when the shutdown is cancelled. The notifier watches that file:

| Event | Level | When |
| :---- | :---- | :--- |
| `shutdown.scheduled` | `warning` | A shutdown was scheduled or moved. Also reported at start-up when one is already scheduled. |
| `shutdown.reminder` | `info` | `SHUTDOWN_REMEMBER_TIME` before the shutdown. Left out when the shutdown is closer than that. |
| `shutdown.cancelled` | `info` | The schedule was removed. |

A change is read once it has settled for `SHUTDOWN_NOTIFY_DELAY`, and reported only when
the time or the mode differs from what was reported last.

## Quick start

```yaml
services:
  shutdown-notifier:
    image: ghcr.io/stefgo/shutdown-notifier:latest
    restart: unless-stopped
    environment:
      - TZ=Europe/Berlin
      - SHUTDOWN_NOTIFY_URL=https://hooks.example.net/shutdown
      - SHUTDOWN_HOSTNAME=zeus
    volumes:
      - /run/systemd/shutdown:/run/systemd/shutdown:ro
      # A template of your own, in place of the one the image ships:
      # - ./config/template.json:/config/template.json:ro
```

The image ships [config/template.json](config/template.json), a flat JSON object with
everything the event carries, written for no target in particular. For a target that expects
a body of its own, mount a template over `/config/template.json` — [samples/](samples/) holds
some to start from.

The complete [compose.yaml](compose.yaml) builds the image from this repository and reads
every setting from the environment, so the URL can live in a `.env` file next to it.

| Tag | Is |
| :-- | :- |
| `latest`, `1.2.3`, `1.2` | A release. |
| `main` | The state of `main`, rebuilt on every push. |
| `dev` | The state of `dev`, for trying out what is not released yet. |

The images are built for `linux/amd64` and `linux/arm64`.

## Configuration

| Variable | Default | Meaning |
| :------- | :------ | :------ |
| `SHUTDOWN_NOTIFY_URL` | – | Where the notification is posted. Without it the events are logged and nothing is sent. Placeholders work, as text. |
| `SHUTDOWN_NOTIFY_HEADERS` | – | Further request headers as a JSON object, e.g. `{"X-Gotify-Key": "<token>"}`. Placeholders work in the values, as text. |
| `SHUTDOWN_NOTIFY_TIMEOUT` | `10` | Seconds one attempt may take. |
| `SHUTDOWN_NOTIFY_TEMPLATE_FILE` | `/config/template.json` | The body template. |
| `SHUTDOWN_HOSTNAME` | hostname of the process | What a template reads as `host.name`. Set it in a container, where the hostname is the container's. |
| `SHUTDOWN_NOTIFY_DELAY` | `3` | Seconds a change has to settle before it is read. |
| `SHUTDOWN_REMEMBER_TIME` | `300` | Seconds before the shutdown at which the reminder is sent. `0` sends none. |
| `SHUTDOWN_POLL_INTERVAL` | `60` | Seconds between two readings of the schedule without a change having been seen — a safety net below the file watch. `0` turns it off. |
| `SHUTDOWN_MONITOR_PATH` | `/run/systemd/shutdown` | The directory that is watched. |
| `SHUTDOWN_MONITOR_FILE` | `scheduled` | The file in it that holds the schedule. |
| `SHUTDOWN_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `TZ` | – | The time zone of `event.scheduledAtLocal` and `event.occurredAtLocal`. |

The template, the URL and the headers are checked at start-up. A broken one ends the process
with a message that says where the mistake is, instead of failing on the first event.

## Delivery

- `POST` with `Content-Type: application/json` and the headers you configured.
- Per attempt the timeout applies. When nothing answers, or the target answers 5xx or 429,
  the delivery is tried twice more, after 1 s and 5 s.
- Events are sent in the order they happened.
- A failure is logged with its reason, never with the URL or the headers.
- On `SIGTERM` a delivery under way is finished before the process ends.

## Trying a template

`--test` renders a sample event, prints the body and — when `SHUTDOWN_NOTIFY_URL` is set —
sends it once, without retries. It takes the event to render: `scheduled` (the default),
`reminder` or `cancelled`.

```sh
# From the source tree
SHUTDOWN_NOTIFY_TEMPLATE_FILE=config/template.json npm start -- --test reminder

# With the image
docker compose run --rm shutdown-notifier dist/index.js --test cancelled
```

The exit code is 1 when the target did not accept the delivery.

## Templates

A template is **valid JSON** with `{{…}}` placeholders in its strings. It is filled in on the
parsed JSON, never as text, so a quote or a brace in an event's data cannot break the body.

| Written as | Becomes |
| :--------- | :------ |
| `"{{event.secondsUntil}}"` — a string that is only one placeholder | The value **with its type**: a number stays a number, a missing value `null`. |
| `"{{host.name}} goes down at {{event.scheduledAtLocal}}"` — a placeholder inside text | Text. A missing value is empty, an object is written as JSON. |
| `{{event.wallMessage \| default("no reason given")}}` | The fallback when the value is missing, `null` or empty. The fallback is a JSON value (`"text"`, `0`, `null`) or text in single quotes (`'text'`). More [filters](#filters) below. |
| `{ "{{event.kind}}": … }` | Placeholders work in keys too, as text. |

A path must start with `event` or `host`; anything else is refused at start-up, as is a
template that is not valid JSON.

### What a template can read

| Placeholder | Content |
| :---------- | :------ |
| `event.kind` | `shutdown.scheduled`, `shutdown.reminder` or `shutdown.cancelled` |
| `event.level` | `warning` for a scheduled shutdown, `info` for a reminder and a cancellation |
| `event.title` | A short heading: `Shutdown scheduled`, `Reminder: scheduled shutdown`, `Scheduled shutdown cancelled` |
| `event.message` | One sentence, e.g. `Shutdown (poweroff) in 5 min, at 5 Oct 2026, 22:30:00 CEST` |
| `event.mode` | `poweroff`, `reboot`, `halt`, …; `null` for a cancellation |
| `event.scheduledAt` | When the shutdown happens (ISO 8601, UTC); `null` for a cancellation |
| `event.scheduledAtLocal` | The same in the time zone of `TZ`, e.g. `5 Oct 2026, 22:30:00 CEST`; `null` for a cancellation |
| `event.occurredAt` | When the event was noticed (ISO 8601, UTC) |
| `event.occurredAtLocal` | The same in the time zone of `TZ` |
| `event.secondsUntil` | Seconds from the event to the shutdown; `null` for a cancellation |
| `event.remaining` | The same in words: `45 s`, `5 min`, `1 h 30 min`; `null` for a cancellation |
| `event.wallMessage` | The message given to `shutdown`, if any; else `null` |
| `event.id` | Unique id of the event |
| `host.name` | `SHUTDOWN_HOSTNAME`, else the hostname of the process |

### Filters

Filters follow the path, separated by `|`, and run left to right. They work everywhere a
placeholder does, URL and headers included.

| Filter | Does |
| :----- | :--- |
| `default(<value>)` | The value when the one before is missing, `null` or empty |
| `join(", ")` | An array as text, its items separated by the given text (`", "` when left out) |
| `map("field")` | From an array of objects, the one field of each |
| `upper`, `lower` | Text in upper or lower case |
| `truncate(12)` | The first characters of a text, cut without an ellipsis. The number is required and at least 1. |

```text
{{event.mode | upper}}                              → POWEROFF
{{event.wallMessage | default('–') | truncate(80)}} → Maintenance
{{event.id | truncate(8)}}                          → 3f2a9c1e
```

A filter handed a value it cannot work on passes it on unchanged. An unknown filter is
refused at start-up. `join` and `map` are part of the language, but a shutdown event carries
no arrays for them to work on.

### Conditions and loops

For what a single placeholder cannot say, a template uses **directives**: JSON objects with a
key starting with `$`. They borrow their names from [JSON-e](https://json-e.js.org/), and
like everything else they work on the parsed JSON, so they cannot break it either.

**`$if`** — takes `then` when the condition holds, else `else`:

```json
{
    "color": { "$if": "event.kind == 'shutdown.cancelled'", "then": 8190976, "else": 16760576 }
}
```

A branch that is left out drops what the directive stands for: the key in an object, the
item in an array (`null` for a whole template). The condition is one of

| Condition | Holds when |
| :-------- | :--------- |
| `path` | the value is there and not `null`, `""`, `false`, `0` or an empty array |
| `!path` | it is not |
| `path == 'reboot'`, `path != 'reboot'` | the value is, or is not, equal to the one given — as a JSON value (`"reboot"`, `600`, `true`, `null`) or text in single quotes. `600` and `'600'` are not equal. |

There is nothing beyond these: no `and`, no `or`, no arithmetic. Two conditions are two
nested `$if`s.

**`$map`** — one item per element of an array, rendered with `each(name)`, in which `name` is
the element; `each(name, index)` adds its position, counted from 0. Anything but an array
gives `[]`.

**`$join`** — renders what it holds and joins the resulting array into text, separated by
`with` (nothing when left out). That is how several optional lines become one message:

```json
{
    "message": {
        "$join": [
            "{{event.message}}",
            { "$if": "event.wallMessage", "then": "Reason: {{event.wallMessage}}" }
        ],
        "with": "\n"
    }
}
```

- An object holding a directive may hold only that directive's own keys (`then`/`else`,
  `each(…)`, `with`); two directives in one object are refused.
- Directives nest at most 8 deep.
- A key that has to reach the target starting with `$if`, `$map` or `$join` is written with a
  second `$`: `"$$if"` is sent as `"$if"`. Other `$` keys, such as `$schema`, are sent as
  written.

## Examples

**[Log Notifier](https://github.com/stefgo/ha-log-notifier) for Home Assistant** —
[samples/ha-lognotifier/template.json](samples/ha-lognotifier/template.json).
`SHUTDOWN_NOTIFY_URL=https://<ha>/api/lognotifier/ingest/<channel token>`. Log Notifier reads
the notifier's levels as its own and renders `content` as Markdown. Without the grid of
fields below the text, it comes down to:

```json
{
    "level": "{{event.level}}",
    "title": "{{host.name}}: {{event.title}}",
    "content": {
        "$join": ["{{event.message}}", { "$if": "event.wallMessage", "then": "> {{event.wallMessage}}" }],
        "with": "\n\n"
    },
    "source": "shutdown-notifier",
    "tags": ["shutdown", "{{event.kind}}"],
    "timestamp": "{{event.occurredAt}}"
}
```

**Discord** — [samples/discord/template.json](samples/discord/template.json).

**Slack / Mattermost incoming webhook**

```json
{
    "text": ":warning: *{{host.name}}* — {{event.message}}"
}
```

**Gotify** — `SHUTDOWN_NOTIFY_URL=https://gotify.example.com/message`,
`SHUTDOWN_NOTIFY_HEADERS={"X-Gotify-Key": "<app token>"}`

```json
{
    "title": "{{host.name}}: {{event.title}}",
    "message": "{{event.message}}",
    "priority": { "$if": "event.kind == 'shutdown.cancelled'", "then": 4, "else": 8 }
}
```

**Your own endpoint**, with everything the event carries — the template the image ships:
[config/template.json](config/template.json).

```json
{
    "source": "shutdown-notifier",
    "id": "{{event.id}}",
    "host": "{{host.name}}",
    "kind": "{{event.kind}}",
    "level": "{{event.level}}",
    "title": "{{event.title}}",
    "message": "{{event.message}}",
    "mode": "{{event.mode}}",
    "scheduledAt": "{{event.scheduledAt}}",
    "secondsUntil": "{{event.secondsUntil}}",
    "wallMessage": "{{event.wallMessage}}",
    "timestamp": "{{event.occurredAt}}"
}
```

## Development

```sh
npm install
npm test          # vitest
npm run typecheck
npm run build     # dist/

# Run against a directory of your own instead of /run/systemd/shutdown
SHUTDOWN_MONITOR_PATH=/tmp/shutdown SHUTDOWN_NOTIFY_TEMPLATE_FILE=config/template.json npm start
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/);
`npm install` activates the hook that checks them. A breaking change is marked with a
`BREAKING CHANGE:` footer, not with `!`.

### Workflows

| Workflow | File | Does |
| :------- | :--- | :--- |
| Check Code | [ci.yml](.github/workflows/ci.yml) | Build, tests and typecheck, on every branch and pull request. |
| Build Images | [build.yml](.github/workflows/build.yml) | Builds the image on a push to `main` or `dev` and for a release tag, starts it, and tags it only when it reported a shutdown. |
| Create Release | [release.yml](.github/workflows/release.yml) | Started by hand on `main`: derives the version from the commits since the last tag, writes `CHANGELOG.md`, tags, and has the image built. `feat:` raises the minor position, `fix:` the patch position. |
| Prune Registry | [cleanup-packages.yml](.github/workflows/cleanup-packages.yml) | Nightly: removes old `sha-*` images and what a failed build left behind. |
| Merge Dependency Updates | [dependabot-auto-merge.yml](.github/workflows/dependabot-auto-merge.yml) | Merges Dependabot's monthly update of the actions once its checks are green. |

[src/template.ts](src/template.ts) is the template engine of the Keepalived Status Monitor
(`shared/src/webhookTemplate.ts`), unchanged apart from the roots a path may start with. A
change to the language belongs there first.

## License

MIT, see [LICENSE](LICENSE).
