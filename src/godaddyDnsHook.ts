import { promises as fs } from 'node:fs';
import dns from 'node:dns/promises';

type HookAction = 'auth' | 'cleanup';

const parseEnvFile = (contents: string) => {
  const parsed = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed.set(key, value);
  }
  return parsed;
};

const parseArgs = (argv: string[]) => {
  const [actionRaw, ...rest] = argv;
  if (actionRaw !== 'auth' && actionRaw !== 'cleanup') {
    throw new Error('First argument must be auth or cleanup.');
  }
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument sequence near ${key ?? '<end>'}.`);
    }
    options.set(key.slice(2), value);
  }
  return { action: actionRaw as HookAction, options };
};

const fetchText = async (response: Response) => response.text().catch(() => '');

const maybeFetchRecords = async (
  apiBaseUrl: string,
  domain: string,
  recordName: string,
  headers: Record<string, string>,
): Promise<Array<{ data: string; ttl?: number }>> => {
  const response = await fetch(
    `${apiBaseUrl}/v1/domains/${encodeURIComponent(domain)}/records/TXT/${encodeURIComponent(recordName)}`,
    { headers },
  );
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(
      `GoDaddy API GET records failed with ${response.status}: ${await fetchText(response) || response.statusText}`,
    );
  }
  return response.json() as Promise<Array<{ data: string; ttl?: number }>>;
};

const buildRecordName = (certbotDomain: string, zone: string) => {
  if (certbotDomain === zone) {
    return '_acme-challenge';
  }
  const suffix = `.${zone}`;
  if (!certbotDomain.endsWith(suffix)) {
    throw new Error(`Domain ${certbotDomain} is not inside managed zone ${zone}.`);
  }
  return `_acme-challenge.${certbotDomain.slice(0, -suffix.length)}`;
};

const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForDnsPropagation = async (
  recordFqdn: string,
  expectedValue: string,
  timeoutMs: number,
  intervalMs: number,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resolved = await dns.resolveTxt(recordFqdn);
      const flattened = resolved.map((entry) => entry.join(''));
      if (flattened.includes(expectedValue)) {
        return;
      }
    } catch {
      // TXT record may not be visible yet.
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `TXT record ${recordFqdn} did not propagate within ${Math.ceil(timeoutMs / 1000)}s.`,
  );
};

const main = async () => {
  const { action, options } = parseArgs(process.argv.slice(2));
  const credentialsFile = options.get('credentials-file');
  if (!credentialsFile) {
    throw new Error('credentials-file is required.');
  }
  const envValues = parseEnvFile(await fs.readFile(credentialsFile, 'utf8'));
  const apiKey = envValues.get('GODADDY_API_KEY')?.trim();
  const apiSecret = envValues.get('GODADDY_API_SECRET')?.trim();
  const configuredZone = envValues.get('GODADDY_ZONE')?.trim();
  if (!apiKey || !apiSecret) {
    throw new Error('Missing GODADDY_API_KEY or GODADDY_API_SECRET in credentials file.');
  }
  if (!configuredZone) {
    throw new Error('Missing GODADDY_ZONE in credentials file.');
  }

  const certbotDomain = process.env.CERTBOT_DOMAIN?.trim();
  const validation = process.env.CERTBOT_VALIDATION?.trim();
  if (!certbotDomain || !validation) {
    throw new Error('CERTBOT_DOMAIN and CERTBOT_VALIDATION are required.');
  }

  const apiBaseUrl = 'https://api.godaddy.com';
  const headers = {
    Authorization: `sso-key ${apiKey}:${apiSecret}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const zone = configuredZone;
  const recordName = buildRecordName(certbotDomain, zone);
  const recordFqdn = `${recordName}.${zone}`;

  if (action === 'auth') {
    const existingRecords = await maybeFetchRecords(apiBaseUrl, zone, recordName, headers);
    const nextRecords = [
      ...existingRecords.filter((record) => record.data !== validation),
      { data: validation, ttl: 600 },
    ];
    const response = await fetch(
      `${apiBaseUrl}/v1/domains/${encodeURIComponent(zone)}/records/TXT/${encodeURIComponent(recordName)}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify(nextRecords),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GoDaddy API PUT records failed with ${response.status}: ${await fetchText(response) || response.statusText}`,
      );
    }
    await sleep(90000);
    await waitForDnsPropagation(recordFqdn, validation, 300000, 15000);
    console.log(`GoDaddy DNS TXT ready: ${recordFqdn}`);
    return;
  }

  const existingRecords = await maybeFetchRecords(apiBaseUrl, zone, recordName, headers);
  const remainingRecords = existingRecords.filter((record) => record.data !== validation);
  if (remainingRecords.length === 0) {
    const response = await fetch(
      `${apiBaseUrl}/v1/domains/${encodeURIComponent(zone)}/records/TXT/${encodeURIComponent(recordName)}`,
      {
        method: 'DELETE',
        headers,
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `GoDaddy API DELETE records failed with ${response.status}: ${await fetchText(response) || response.statusText}`,
      );
    }
  } else {
    const response = await fetch(
      `${apiBaseUrl}/v1/domains/${encodeURIComponent(zone)}/records/TXT/${encodeURIComponent(recordName)}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify(remainingRecords),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GoDaddy API PUT cleanup failed with ${response.status}: ${await fetchText(response) || response.statusText}`,
      );
    }
  }
  console.log(`GoDaddy DNS TXT cleaned up: ${recordFqdn}`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
