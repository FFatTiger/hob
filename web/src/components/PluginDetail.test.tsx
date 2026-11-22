import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../store.ts', () => ({ useApp: () => ({ assistants: [] }) }));
vi.mock('./Plugins.tsx', () => ({}));
import { configGroups, MoreSettings } from './PluginDetail.tsx';

describe('optional plugin settings', () => {
  it('starts closed when required fields exist and optional fields are empty', () => {
    const result = configGroups({ address: { required: true }, host: { type: 'string' }, secret: { sensitive: true, configured: false } }, {});
    expect(result.required.map(([key]) => key)).toEqual(['address']);
    expect(result.optional).toHaveLength(2);
    expect(renderToStaticMarkup(<MoreSettings initialOpen={result.initialOpen}>fields</MoreSettings>)).toContain('<button type="button" class="disclosure-row" aria-expanded="false"');
  });
  it('opens for saved values, saved secrets, and forms without required fields', () => {
    expect(configGroups({ address: { required: true }, host: { value: 'server.test' } }, {}).initialOpen).toBe(true);
    expect(configGroups({ address: { required: true }, secret: { sensitive: true, configured: true } }, {}).initialOpen).toBe(true);
    expect(configGroups({ host: {} }, {}).initialOpen).toBe(true);
  });
  it('does not provide a more-settings section when all fields are required', () => {
    expect(configGroups({ token: { required: true } }, {}).optional).toHaveLength(0);
  });
});
