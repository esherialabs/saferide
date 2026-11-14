import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0,
  refs: [] as { current: unknown }[], refCursor: 0,
  setTheme: vi.fn(), setVisualStyle: vi.fn(),
}));

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = runtime.cursor++;
      if (!(index in runtime.values)) runtime.values[index] = initial;
      return [runtime.values[index], (value: unknown) => { runtime.values[index] = value; }];
    },
    useRef: (initial: unknown) => {
      const index = runtime.refCursor++;
      runtime.refs[index] ??= { current: initial };
      return runtime.refs[index];
    },
  };
});
vi.mock('react-native', () => ({
  Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('./Button', () => ({ default: 'Button' }));
vi.mock('./IconButton', () => ({ IconButton: 'IconButton' }));
vi.mock('../../context/LanguageProvider', () => ({ useLanguage: () => ({ languageCode: 'en' }) }));
vi.mock('../../theme/SimpleThemeProvider', () => ({
  useTheme: () => ({
    colors: {}, theme: 'light', mode: 'light', visualStyle: 'warm', isHighContrast: false,
    setTheme: runtime.setTheme, setVisualStyle: runtime.setVisualStyle,
  }),
}));

import { AppearanceControl } from './AppearanceControl';

type NodeProps = { children?: React.ReactNode; [key: string]: unknown };
function findNode(node: React.ReactNode, predicate: (props: NodeProps) => boolean): React.ReactElement<NodeProps> {
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement<NodeProps>(child)) continue;
    if (predicate(child.props)) return child;
    try { return findNode(child.props.children, predicate); } catch { /* Search the next branch. */ }
  }
  throw new Error('Control not found in rendered appearance chooser');
}
function renderControl() {
  runtime.cursor = 0;
  runtime.refCursor = 0;
  return AppearanceControl({});
}
function press(label: string) {
  const button = findNode(renderControl(), props => props.accessibilityLabel === label);
  (button.props.onPress as () => void)();
}

beforeEach(() => {
  runtime.values = [];
  runtime.refs = [];
  runtime.setTheme.mockReset();
  runtime.setVisualStyle.mockReset();
});

describe('appearance display-mode feedback', () => {
  it('shows a failed display save and lets the same choice retry successfully', async () => {
    runtime.setTheme.mockRejectedValueOnce(new Error('Synthetic write failure'));
    press('Dark');
    await Promise.resolve();
    const alert = findNode(renderControl(), props => props.accessibilityRole === 'alert');
    expect(alert.props.children).toBe('Could not save your appearance. Please try again.');

    runtime.setTheme.mockResolvedValueOnce(undefined);
    press('Dark');
    await Promise.resolve();
    expect(runtime.setTheme).toHaveBeenCalledTimes(2);
    expect(() => findNode(renderControl(), props => props.accessibilityRole === 'alert')).toThrow('Control not found');
  });

  it('disables both choice groups and blocks duplicate presses until persistence finishes', async () => {
    let finish!: () => void;
    runtime.setTheme.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    press('Dark');
    press('High contrast');
    const tree = renderControl();
    expect(findNode(tree, props => props.accessibilityLabel === 'Dark').props.disabled).toBe(true);
    const classic = findNode(tree, props => typeof props.accessibilityLabel === 'string' && props.accessibilityLabel.startsWith('Classic.'));
    expect(classic.props.disabled).toBe(true);
    (classic.props.onPress as () => void)();
    expect(runtime.setTheme).toHaveBeenCalledOnce();
    expect(runtime.setVisualStyle).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    expect(findNode(renderControl(), props => props.accessibilityLabel === 'Dark').props.disabled).toBe(false);
  });
});
