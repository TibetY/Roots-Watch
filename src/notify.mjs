// Alert delivery for the Roots stock watcher.
//
// One channel: a generic JSON webhook — ntfy, Pushover, Slack, Discord, an
// IFTTT/Zapier hook, anything that accepts a JSON POST.
//
// Nothing here throws. A notification failure must never kill the watch loop —
// if the webhook is down at 9am we still want the 9:30 check to run, and we
// want the failure visible in the run log rather than as a crashed process.

/**
 * Read notification config out of the environment.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function readNotifyConfig(env = process.env) {
  return {
    webhookUrl: env.ROOTS_WATCH_WEBHOOK ?? '',
    // ntfy only parses JSON when you POST to its bare origin with `topic` in
    // the body — posting straight to /<topic> treats the whole JSON body as
    // literal message text. Leave unset for webhooks that already encode
    // their destination in the URL (Slack, Discord, Pushover).
    webhookTopic: env.ROOTS_WATCH_WEBHOOK_TOPIC ?? '',
  };
}

/**
 * True when a notification channel is configured. Used to warn loudly at
 * startup rather than silently watching a page with nowhere to send the news.
 */
export function hasAnyChannel(config) {
  return Boolean(config.webhookUrl);
}

/** POST the alert as JSON to a generic webhook. */
export async function sendWebhook(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `text` and `content` are included alongside `message` so the same hook
    // works with Slack, Discord and ntfy without a translation layer.
    body: JSON.stringify({ ...payload, text: payload.message, content: payload.message }),
  });

  if (!response.ok) {
    throw new Error(`Webhook responded ${response.status}`);
  }
}

/**
 * Fan the alert out to the configured channel.
 *
 * @returns {Promise<Array<{channel: string, ok: boolean, detail?: string}>>}
 */
export async function notifyAll(config, message, payload = {}) {
  const results = [];

  if (config.webhookUrl) {
    try {
      // `title` and `url` are caller-supplied (see index.mjs) so the ntfy
      // notification can name the size that's in stock and, via `click`, open
      // the buy link directly when tapped — a plain `url` field in the JSON
      // body isn't a key ntfy recognizes, so it has to be re-mapped here.
      const ntfyFields = config.webhookTopic
        ? {
            topic: config.webhookTopic,
            title: payload.title ?? 'Roots stock watch',
            ...(payload.url ? { click: payload.url } : {}),
          }
        : {};
      await sendWebhook(config.webhookUrl, { ...ntfyFields, ...payload, message });
      results.push({ channel: 'webhook', ok: true });
    } catch (error) {
      results.push({ channel: 'webhook', ok: false, detail: String(error.message ?? error) });
    }
  }

  return results;
}
