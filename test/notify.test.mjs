import { beforeEach, describe, expect, it, vi } from 'vitest';

import { notifyAll, readNotifyConfig } from '../src/notify.mjs';

describe('notify configuration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads webhook config from the environment', () => {
    const config = readNotifyConfig({
      ROOTS_WATCH_WEBHOOK: 'https://ntfy.sh',
      ROOTS_WATCH_WEBHOOK_TOPIC: 'my-topic',
    });

    expect(config).toEqual({
      webhookUrl: 'https://ntfy.sh',
      webhookTopic: 'my-topic',
    });
  });

  it('has no channel configured when the webhook URL is unset', () => {
    const config = readNotifyConfig({});
    expect(config.webhookUrl).toBe('');
  });

  it('posts message/text/content plus ntfy topic and title when a topic is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const config = readNotifyConfig({
      ROOTS_WATCH_WEBHOOK: 'https://ntfy.sh',
      ROOTS_WATCH_WEBHOOK_TOPIC: 'my-topic',
    });

    const results = await notifyAll(config, 'Restocked');

    expect(results).toEqual([{ channel: 'webhook', ok: true }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ntfy.sh');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      topic: 'my-topic',
      title: 'Roots stock watch',
      message: 'Restocked',
      text: 'Restocked',
      content: 'Restocked',
    });
  });

  it('uses a caller-supplied title and maps url to ntfy\'s click field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const config = readNotifyConfig({
      ROOTS_WATCH_WEBHOOK: 'https://ntfy.sh',
      ROOTS_WATCH_WEBHOOK_TOPIC: 'my-topic',
    });

    await notifyAll(config, 'Restocked', {
      title: 'Roots in stock — size 3 & 5',
      url: 'https://www.roots.com/buy-link',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      topic: 'my-topic',
      title: 'Roots in stock — size 3 & 5',
      url: 'https://www.roots.com/buy-link',
      click: 'https://www.roots.com/buy-link',
      message: 'Restocked',
      text: 'Restocked',
      content: 'Restocked',
    });
  });

  it('omits topic/title for a plain webhook URL (Slack/Discord/Pushover style)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const config = readNotifyConfig({
      ROOTS_WATCH_WEBHOOK: 'https://hooks.example.test/services/xyz',
    });

    await notifyAll(config, 'Restocked');

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      message: 'Restocked',
      text: 'Restocked',
      content: 'Restocked',
    });
  });

  it('reports a failed webhook without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);

    const config = readNotifyConfig({ ROOTS_WATCH_WEBHOOK: 'https://ntfy.sh' });

    const results = await notifyAll(config, 'Restocked');

    expect(results).toEqual([
      { channel: 'webhook', ok: false, detail: 'Webhook responded 503' },
    ]);
  });
});
