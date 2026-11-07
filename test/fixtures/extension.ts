export const extensionFixture = {
  stage: 'bootstrap', fqdn: 'notifications.example.com', cloudflareZoneId: 'a'.repeat(32),
  serviceName: 'miwkey-extension', namespace: 'miwkey-internal',
  image: `ghcr.io/mi-24v/miwkey-extension@sha256:${'a'.repeat(64)}`,
  accountEmail: 'operator@example.com',
  budgets: {mainCpu: 1280, mainMemory: 2048, extensionCpu: 512, extensionMemory: 1024,
    appCpu: 256, appMemory: 512},
  renewalDays: 30, warningDays: 14,
};
