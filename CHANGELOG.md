# [1.0.0](https://github.com/stefgo/shutdown-notifier/compare/v0.0.1...v1.0.0) (2026-10-07)


### Features

* Publish the events to an MQTT broker as well ([a68225e](https://github.com/stefgo/shutdown-notifier/commit/a68225ecb959e25f9b391c217f2a8a393b7687d4))
* Ship a template that is written for no target in particular ([f0873b7](https://github.com/stefgo/shutdown-notifier/commit/f0873b7fa3936e380884a4ad05b941a08029debb))


### BREAKING CHANGES

* SHUTDOWN_NOTIFY_URL, SHUTDOWN_NOTIFY_HEADERS,
SHUTDOWN_NOTIFY_TIMEOUT and SHUTDOWN_NOTIFY_TEMPLATE_FILE are now
SHUTDOWN_HTTP_URL, SHUTDOWN_HTTP_HEADERS, SHUTDOWN_HTTP_TIMEOUT and
SHUTDOWN_HTTP_TEMPLATE_FILE. The old names are no longer read.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
