import {parseExtensionProps, loadExtensionProps} from '../lib/config/loader';

import {extensionFixture as fixture} from './fixtures/extension';

test('missing optional configuration keeps the extension disabled', () => {
  expect(loadExtensionProps('test/fixtures/absent.json')).toBeUndefined();
});

test('accepts fixture configuration without production defaults', () => {
  expect(parseExtensionProps(fixture)).toEqual({...fixture, staging: false});
});

test.each([
  {fqdn: 'https://example.com'}, {fqdn: '*.example.com'}, {fqdn: 'localhost'},
  {cloudflareZoneId: ''}, {image: 'ghcr.io/mi-24v/miwkey-extension:latest'},
  {warningDays: 30}, {renewalDays: 0}, {accountEmail: ''}, {token: 'never accepted'},
  {budgets: {...fixture.budgets, mainCpu: 1024}},
  {budgets: {...fixture.budgets, extensionMemory: 512}},
  {stage: 'scheduled'}, {stage: 'client', staging: true},
])('rejects invalid or unsafe configuration %p', patch => {
  expect(() => parseExtensionProps({...fixture, ...patch})).toThrow();
});

test('scheduled stage requires the explicit alert recipient', () => {
  expect(parseExtensionProps({...fixture, stage: 'scheduled', alertEmail: 'operator@example.com', monitoringStart: '2026-10-17T00:00:00Z'}).stage).toBe('scheduled');
});

test('scheduled monitoring requires an explicit UTC activation time and enough warning horizon', () => {
  expect(() => parseExtensionProps({...fixture, stage: 'scheduled', alertEmail: 'operator@example.com'})).toThrow();
  expect(() => parseExtensionProps({...fixture, stage: 'scheduled', alertEmail: 'operator@example.com', monitoringStart: 'not-a-date'})).toThrow();
  expect(() => parseExtensionProps({...fixture, stage: 'scheduled', alertEmail: 'operator@example.com', monitoringStart: '2026-10-17T00:00:00Z', warningDays: 3})).toThrow();
});
