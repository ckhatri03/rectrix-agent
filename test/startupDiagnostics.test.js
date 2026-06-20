const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { validateStartupEnvironment } = require('../dist/startupDiagnostics');

test('startup allows manager-assisted AWS IoT claim bootstrap', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rectrix-startup-'));
  const envPath = path.join(tempDir, 'agent.env');
  const statePath = path.join(tempDir, 'state.json');
  const previousEnvPath = process.env.AGENT_ENV_FILE_PATH;
  const previousStatePath = process.env.STATE_FILE;

  await fs.writeFile(envPath, [
    'MANAGER_API_URL=https://manager-prod.sensorlog.io',
    'AGENT_ACTIVATION_CODE=ABCDEFGHIJKLMNOPQRSTUVWX',
    'CONTROL_PLANE_MODE=aws-iot-mqtt',
    '',
  ].join('\n'));

  process.env.AGENT_ENV_FILE_PATH = envPath;
  process.env.STATE_FILE = statePath;
  try {
    await assert.doesNotReject(validateStartupEnvironment());
  } finally {
    if (previousEnvPath === undefined) delete process.env.AGENT_ENV_FILE_PATH;
    else process.env.AGENT_ENV_FILE_PATH = previousEnvPath;
    if (previousStatePath === undefined) delete process.env.STATE_FILE;
    else process.env.STATE_FILE = previousStatePath;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
