const test = require('node:test');
const assert = require('node:assert/strict');

const { runJob } = require('../dist/jobHandlers');

test('agent diagnostics accepts aws-iot-mqtt as the expected transport mode', async () => {
  const result = await runJob({
    id: 'diagnostics-aws-iot-mqtt',
    type: 'agent.diagnostics.snapshot',
    payload: { expectedTransportMode: 'aws-iot-mqtt' },
    raw: {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.details.expectedTransportMode, 'aws-iot-mqtt');
});
