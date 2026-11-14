import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = runtime.cursor++;
      if (!(index in runtime.values)) runtime.values[index] = initial;
      return [runtime.values[index], (value: unknown) => { runtime.values[index] = typeof value === 'function' ? value(runtime.values[index]) : value; }];
    },
    useRef: (initial: unknown) => {
      const index = runtime.refCursor++;
      runtime.refs[index] ??= { current: initial };
      return runtime.refs[index];
    },
    useEffect: vi.fn(),
  };
});
vi.mock('react-native', () => ({ Modal: 'Modal', View: 'View', Text: 'Text', Image: 'Image', TouchableOpacity: 'TouchableOpacity', ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles }, Dimensions: { get: () => ({ width: 360, height: 800 }) } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('./Button', () => ({ default: 'Button' }));
vi.mock('../../utils/accessibility', () => ({ AccessibilityManager: {} }));
import PhotoAnnotationOverlay, { type PhotoAnnotationProps } from './PhotoAnnotationOverlay';

type NodeProps = { children?: React.ReactNode; [key: string]: unknown };
function findNode(node: React.ReactNode, predicate: (props: NodeProps) => boolean): React.ReactElement<NodeProps> {
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement<NodeProps>(child)) continue;
    if (predicate(child.props)) return child;
    try { return findNode(child.props.children, predicate); } catch { /* Search next branch. */ }
  }
  throw new Error('Annotation control not found');
}
function renderEditor(props: PhotoAnnotationProps) {
  runtime.cursor = 0; runtime.refCursor = 0;
  return PhotoAnnotationOverlay(props);
}
function pressSave(props: PhotoAnnotationProps) {
  const node = findNode(renderEditor(props), p => typeof p.title === 'string' && p.title.startsWith('Save ('));
  (node.props.onPress as () => void)();
}
beforeEach(() => { runtime.values = []; runtime.refs = []; });

describe('annotation save acknowledgement', () => {
  it('waits for persistence, disables duplicate saves and closes once after success', async () => {
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onClose = vi.fn();
    const props = { visible: true, imageUri: 'file:///synthetic.jpg', onSave, onClose };
    pressSave(props); pressSave(props);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(findNode(renderEditor(props), p => typeof p.title === 'string' && p.title.startsWith('Save (')).props.disabled).toBe(true);
    finish(); await Promise.resolve();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['false', 'reject'])('retains the editor and annotations on %s and allows retry', async failure => {
    const onSave = vi.fn().mockImplementationOnce(() => failure === 'false' ? Promise.resolve(false) : Promise.reject(new Error('Synthetic failure'))).mockResolvedValue(true);
    const onClose = vi.fn();
    const annotations = [{ id: 'synthetic', type: 'note' as const, x: 50, y: 50, label: 'Synthetic note' }];
    const props = { visible: true, imageUri: 'file:///synthetic.jpg', annotations, onSave, onClose };
    pressSave(props); await Promise.resolve();
    expect(onClose).not.toHaveBeenCalled();
    expect(findNode(renderEditor(props), p => p.accessibilityRole === 'alert').props.children).toContain('could not be saved');
    pressSave(props); await Promise.resolve();
    expect(onSave).toHaveBeenLastCalledWith(annotations);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not close another editor after the user cancels a pending save', async () => {
    let finish!: () => void;
    const onClose = vi.fn();
    const props = { visible: true, imageUri: 'file:///synthetic.jpg', onClose, onSave: () => new Promise<void>(resolve => { finish = resolve; }) };
    pressSave(props);
    (findNode(renderEditor(props), p => p.title === 'Cancel').props.onPress as () => void)();
    expect(onClose).toHaveBeenCalledOnce();
    finish(); await Promise.resolve();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
