const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

process.env.USE_WEB_INTERFACE = 'true';
process.env.CODEX_SANDBOX = 'workspace-write';

const {
  AppServerClient,
  cleanupTempDir,
  extractAndSaveImages,
  messagesToAppServerInput,
} = require('../server');

test('turnStart forwards request-level reasoning effort', async () => {
  const client = new AppServerClient();
  let captured;
  client.request = async (method, params) => {
    captured = { method, params };
    return { turn: { id: 'turn-1' } };
  };

  await client.turnStart({
    threadId: 'thread-1',
    input: [{ type: 'text', text: 'hello' }],
    model: 'gpt-5.5',
    effort: 'low',
  });

  assert.equal(captured.method, 'turn/start');
  assert.equal(captured.params.effort, 'low');
});

test('base64 images are passed to app-server as localImage input', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'describe it' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  }];
  const { images, tempDir } = extractAndSaveImages(messages);

  try {
    const input = messagesToAppServerInput(messages, images);
    assert.deepEqual(input[0], { type: 'text', text: 'describe it' });
    assert.equal(input[1].type, 'localImage');
    assert.equal(input[1].path, images[0].path);
    assert.equal(fs.existsSync(input[1].path), true);
  } finally {
    cleanupTempDir(tempDir);
  }
});

test('unsupported remote images do not shift following local images', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'https://example.com/remote.png' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  }];
  const { images, tempDir } = extractAndSaveImages(messages);

  try {
    const input = messagesToAppServerInput(messages, images);
    assert.equal(images[0], null);
    assert.equal(input.filter(item => item.type === 'localImage').length, 1);
    assert.equal(input[0].path, images[1].path);
  } finally {
    cleanupTempDir(tempDir);
  }
});
