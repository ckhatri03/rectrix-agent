const test = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITIES } = require('../dist/config');
const { runJob } = require('../dist/jobHandlers');

test('agent advertises the complete AWS IoT certificate rotation workflow', () => {
  assert.ok(CAPABILITIES.includes('aws-iot.certificate.prepare'));
  assert.ok(CAPABILITIES.includes('aws-iot.certificate.install'));
  assert.ok(CAPABILITIES.includes('aws-iot.certificate.cleanup'));
});

test('certificate installation rejects incomplete manager payloads before touching disk', async () => {
  await assert.rejects(
    runJob({
      id: 'job-invalid-rotation',
      type: 'aws-iot.certificate.install',
      payload: { certificateArn: 'not-an-arn', certificatePem: 'not-a-certificate' },
      raw: {},
    }),
  );
});
