import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Image,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { touchTargets } from '../../theme/tokens';
import { AccessibilityManager } from '../../utils/accessibility';
import {
  createCoordinateAnnotation,
  createPresetAnnotation,
  describeAnnotation,
  type AnnotationPoint,
  type AnnotationPresetRegion,
  type AnnotationTool,
} from '../../utils/photoAnnotation';
import Button from './Button';

export type { AnnotationPoint } from '../../utils/photoAnnotation';

export interface PhotoAnnotationProps {
  visible: boolean;
  imageUri: string;
  annotations?: AnnotationPoint[];
  onClose: () => void;
  onSave?: (annotations: AnnotationPoint[]) => void | boolean | Promise<void | boolean>;
  readonly?: boolean;
}

export default function PhotoAnnotationOverlay({
  visible,
  imageUri,
  annotations = [],
  onClose,
  onSave,
  readonly = false,
}: PhotoAnnotationProps) {
  const [currentAnnotations, setCurrentAnnotations] = useState<AnnotationPoint[]>(annotations);
  const [selectedTool, setSelectedTool] = useState<AnnotationTool>('blur');
  const [imageLayout, setImageLayout] = useState({ width: 0, height: 0, x: 0, y: 0 });
  const annotationSequence = useRef(0);
  const modalTitleRef = useRef<Text>(null);
  const wasVisible = useRef(false);
  const savingRef = useRef(false);
  const saveSession = useRef(0);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    saveSession.current += 1;
    savingRef.current = false;
    setSaving(false);
    setSaveFailed(false);
    return () => { saveSession.current += 1; };
  }, [visible, imageUri]);

  const screenWidth = Dimensions.get('window').width;
  const screenHeight = Dimensions.get('window').height;

  useEffect(() => {
    if (visible && !wasVisible.current) {
      setCurrentAnnotations(annotations);
    }
    wasVisible.current = visible;
  }, [annotations, visible]);

  const nextAnnotationId = () => {
    annotationSequence.current += 1;
    return `annotation-${Date.now()}-${annotationSequence.current}`;
  };

  const handleImagePress = (event: any) => {
    if (readonly || savingRef.current) return;

    const { locationX, locationY } = event.nativeEvent;
    const { width, height } = imageLayout;

    if (width === 0 || height === 0) return;

    const xPercent = (locationX / width) * 100;
    const yPercent = (locationY / height) * 100;

    const newAnnotation = createCoordinateAnnotation(
      selectedTool,
      xPercent,
      yPercent,
      nextAnnotationId(),
    );

    setCurrentAnnotations(prev => [...prev, newAnnotation]);
  };

  const addPresetAnnotation = (region: AnnotationPresetRegion) => {
    if (savingRef.current) return;
    setCurrentAnnotations(prev => [
      ...prev,
      createPresetAnnotation(selectedTool, region, nextAnnotationId()),
    ]);
  };

  const removeAnnotation = (id: string) => {
    if (savingRef.current) return;
    setCurrentAnnotations(prev => prev.filter(a => a.id !== id));
  };

  const closeEditor = () => {
    saveSession.current += 1;
    onClose();
  };
  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    const session = saveSession.current;
    try {
      const saved = await onSave?.(currentAnnotations);
      if (saveSession.current !== session) return;
      if (saved === false) setSaveFailed(true);
      else closeEditor();
    } catch {
      if (saveSession.current === session) setSaveFailed(true);
    } finally {
      if (saveSession.current === session) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  const getAnnotationIcon = (type: AnnotationTool) => {
    switch (type) {
      case 'blur': return 'eye-off';
      case 'highlight': return 'star';
      case 'note': return 'chatbubble';
    }
  };

  const getAnnotationColor = (type: AnnotationTool) => {
    switch (type) {
      case 'blur': return '#EF4444';
      case 'highlight': return '#F59E0B';
      case 'note': return '#3B82F6';
    }
  };

  const styles = StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.9)',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: 50,
      paddingBottom: 16,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    closeButton: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: touchTargets.minimum,
      minWidth: touchTargets.minimum,
    },
    imageContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      position: 'relative',
    },
    image: {
      maxWidth: screenWidth - 32,
      maxHeight: screenHeight * 0.6,
    },
    annotationPoint: {
      position: 'absolute',
      width: touchTargets.minimum,
      height: touchTargets.minimum,
      borderRadius: touchTargets.minimum / 2,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: '#FFFFFF',
    },
    toolbar: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 16,
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      flexWrap: 'wrap',
    },
    toolButton: {
      flexDirection: 'column',
      alignItems: 'center',
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 8,
      minWidth: 60,
      minHeight: touchTargets.minimum,
    },
    toolButtonActive: {
      backgroundColor: 'rgba(255, 255, 255, 0.2)',
    },
    toolButtonText: {
      fontSize: 12,
      color: '#FFFFFF',
      marginTop: 4,
    },
    presetPanel: {
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      paddingHorizontal: 16,
      paddingBottom: 12,
      gap: 8,
    },
    presetTitle: {
      color: '#FFFFFF',
      fontSize: 14,
      fontWeight: '600',
    },
    presetHint: {
      color: '#E5E7EB',
      fontSize: 12,
    },
    presetActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    annotationList: {
      maxHeight: 116,
    },
    annotationListContent: {
      gap: 8,
    },
    annotationListRow: {
      alignItems: 'center',
      borderColor: '#6B7280',
      borderRadius: 8,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 8,
      minHeight: touchTargets.minimum,
      paddingLeft: 12,
    },
    annotationListText: {
      color: '#FFFFFF',
      flex: 1,
      fontSize: 13,
    },
    removeButton: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: touchTargets.minimum,
      minWidth: touchTargets.minimum,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingBottom: 32,
      gap: 12,
    },
  });

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={closeEditor}
      onShow={() => AccessibilityManager.focusElement(modalTitleRef)}
    >
      <View style={styles.overlay} accessibilityViewIsModal>
        {/* Header */}
        <View style={styles.header}>
          <Text ref={modalTitleRef} accessibilityRole="header" style={styles.headerTitle}>
            {readonly ? 'View Annotations' : 'Annotate Photo'}
          </Text>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={closeEditor}
            accessibilityRole="button"
            accessibilityLabel="Close photo annotation"
            accessibilityHint="Returns without saving new annotation changes"
          >
            <Ionicons name="close" size={24} color="#FFFFFF" />
          </TouchableOpacity>
        </View>

        {/* Image with Annotations */}
        <View style={styles.imageContainer}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={handleImagePress}
            disabled={readonly || saving}
            accessible={false}
          >
            <Image
              source={{ uri: imageUri }}
              style={styles.image}
              resizeMode="contain"
              accessible
              accessibilityRole="image"
              accessibilityLabel={`Photo preview with ${currentAnnotations.length} annotations`}
              onLayout={(event) => {
                const { width, height, x, y } = event.nativeEvent.layout;
                setImageLayout({ width, height, x, y });
              }}
            />
            
            {/* Render Annotations */}
            {currentAnnotations.map((annotation) => (
              <TouchableOpacity
                key={annotation.id}
                style={[
                  styles.annotationPoint,
                  {
                    backgroundColor: getAnnotationColor(annotation.type),
                    left: `${annotation.x}%`,
                    top: `${annotation.y}%`,
                    transform: [
                      { translateX: -touchTargets.minimum / 2 },
                      { translateY: -touchTargets.minimum / 2 },
                    ],
                  },
                ]}
                onPress={() => !readonly && removeAnnotation(annotation.id)}
                disabled={readonly || saving}
                accessibilityRole={readonly ? 'image' : 'button'}
                accessibilityLabel={readonly
                  ? describeAnnotation(annotation)
                  : `Remove ${describeAnnotation(annotation)}`}
                accessibilityHint={readonly ? undefined : 'Removes this annotation from the photo'}
              >
                <Ionicons
                  name={getAnnotationIcon(annotation.type) as any}
                  size={16}
                  color="#FFFFFF"
                />
              </TouchableOpacity>
            ))}
          </TouchableOpacity>
        </View>

        {/* Tool Selection */}
        {!readonly && (
          <View
            style={styles.toolbar}
            accessibilityRole="radiogroup"
            accessibilityLabel="Choose annotation tool"
          >
            {(['blur', 'highlight', 'note'] as const).map((tool) => (
              <TouchableOpacity
                key={tool}
                style={[
                  styles.toolButton,
                  selectedTool === tool && styles.toolButtonActive,
                ]}
                onPress={() => setSelectedTool(tool)}
                disabled={saving}
                accessibilityRole="radio"
                accessibilityLabel={`${tool.charAt(0).toUpperCase() + tool.slice(1)} annotation tool`}
                accessibilityState={{ selected: selectedTool === tool }}
              >
                <Ionicons
                  name={getAnnotationIcon(tool) as any}
                  size={24}
                  color={selectedTool === tool ? getAnnotationColor(tool) : '#FFFFFF'}
                />
                <Text style={styles.toolButtonText}>
                  {tool.charAt(0).toUpperCase() + tool.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {!readonly && (
          <View style={styles.presetPanel}>
            <Text style={styles.presetTitle}>Accessible placement</Text>
            <Text style={styles.presetHint}>
              Add the selected annotation without tapping an image coordinate.
            </Text>
            <View style={styles.presetActions}>
              {(['top', 'center', 'bottom'] as const).map(region => (
                <Button
                  key={region}
                  size="sm"
                  variant="outline"
                  title={`Add at ${region}`}
                  accessibilityHint={`Adds the selected ${selectedTool} tool at the ${region} of the photo`}
                  onPress={() => addPresetAnnotation(region)}
                  disabled={saving}
                />
              ))}
            </View>
            {currentAnnotations.length > 0 ? (
              <ScrollView
                style={styles.annotationList}
                contentContainerStyle={styles.annotationListContent}
                accessibilityLabel="Current annotations"
              >
                {currentAnnotations.map(annotation => (
                  <View key={`list-${annotation.id}`} style={styles.annotationListRow}>
                    <Text style={styles.annotationListText}>{describeAnnotation(annotation)}</Text>
                    <TouchableOpacity
                      style={styles.removeButton}
                      onPress={() => removeAnnotation(annotation.id)}
                      disabled={saving}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${describeAnnotation(annotation)}`}
                    >
                      <Ionicons name="trash-outline" size={20} color="#FFFFFF" />
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            ) : null}
          </View>
        )}

        {/* Action Buttons */}
        {saveFailed ? <Text accessibilityRole="alert" style={{ color: '#FFFFFF', paddingHorizontal: 16 }}>Annotations could not be saved. Try again before closing.</Text> : null}
        <View style={styles.actions}>
          <Button
            title="Cancel"
            variant="outline"
            onPress={closeEditor}
            style={{ flex: 1 }}
          />
          {!readonly && (
            <Button
              title={`Save (${currentAnnotations.length})`}
              onPress={() => { void handleSave(); }}
              disabled={saving}
              loading={saving}
              style={{ flex: 2 }}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

// Convenience hook for using photo annotations
export function usePhotoAnnotation() {
  const [visible, setVisible] = useState(false);
  const [currentImage, setCurrentImage] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationPoint[]>([]);

  const openAnnotation = (imageUri: string, existingAnnotations: AnnotationPoint[] = []) => {
    setCurrentImage(imageUri);
    setAnnotations(existingAnnotations);
    setVisible(true);
  };

  const closeAnnotation = () => {
    setVisible(false);
    setCurrentImage(null);
    setAnnotations([]);
  };

  return {
    visible,
    currentImage,
    annotations,
    openAnnotation,
    closeAnnotation,
    setAnnotations,
  };
}
