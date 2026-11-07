import {parseHostProps, loadHostProps} from '../lib/config/loader';

test.each([{}, {amiId: ''}, {amiId: 'recommended'}, {amiId: 'ami-wrong'}, {amiId: 'ami-0123456789abcdef0', token: 'invalid'}])('host AMI configuration rejects missing or invalid input %p', value => {
  expect(() => parseHostProps(value)).toThrow();
});

test('host image is explicit and has no deployment-time fallback', () => {
  expect(parseHostProps({amiId: 'ami-0123456789abcdef0'})).toEqual({amiId: 'ami-0123456789abcdef0'});
  expect(() => loadHostProps('test/fixtures/absent.json')).toThrow();
});
