import React from 'react';
import { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useTheme } from '../../theme/SimpleThemeProvider';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from './Sheet';
import Button from './Button';
import { radii, touchTargets } from '../../theme/tokens';

function daysInMonth(year: number, monthIndex: number) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function pad(n: number) {
  return n.toString().padStart(2, '0');
}

export function DateField({ label, value, onChange }: { label: string; value: Date; onChange: (d: Date) => void }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(value.getFullYear());
  const [month, setMonth] = useState(value.getMonth());
  const [day, setDay] = useState(value.getDate());

  const years = useMemo(() => {
    const y = value.getFullYear();
    const range: number[] = [];
    for (let i = y - 5; i <= y + 1; i++) range.push(i);
    return range;
  }, [value]);

  const days = useMemo(() => {
    return Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1);
  }, [year, month]);

  const apply = () => {
    const updated = new Date(value);
    updated.setFullYear(year);
    updated.setMonth(month);
    updated.setDate(Math.min(day, daysInMonth(year, month)));
    onChange(updated);
    setOpen(false);
  };

  const styles = StyleSheet.create({
    field: { minHeight: touchTargets.minimum, justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.divider, borderRadius: radii.input, backgroundColor: colors.surface },
    fieldText: { color: colors.foreground },
    column: { flex: 1 },
    option: { minHeight: touchTargets.minimum, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 8, borderRadius: radii.input, marginBottom: 6 },
    optionActive: { backgroundColor: colors.primaryMuted, borderWidth: 1, borderColor: colors.primary },
    optionText: { textAlign: 'center', color: colors.foreground },
    header: { marginBottom: 8, color: colors.textSecondary },
    grid: { flexDirection: 'row', gap: 12 },
  });

  return (
    <>
      <TouchableOpacity onPress={() => setOpen(true)} style={styles.field}>
        <Text style={styles.fieldText}>{label}: {value.getFullYear()}-{pad(value.getMonth() + 1)}-{pad(value.getDate())}</Text>
      </TouchableOpacity>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent snapPoints={[0.95]} initialSnapPoint={0}>
          <SheetHeader>
            <SheetTitle>Select date</SheetTitle>
          </SheetHeader>
          <View style={styles.grid}>
            <View style={styles.column}>
              <Text style={styles.header}>Year</Text>
              <ScrollView style={{ maxHeight: 240 }}>
                {years.map((y) => (
                  <TouchableOpacity key={y} onPress={() => setYear(y)} style={[styles.option, year === y && styles.optionActive]}>
                    <Text style={styles.optionText}>{y}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
            <View style={styles.column}>
              <Text style={styles.header}>Month</Text>
              <ScrollView style={{ maxHeight: 240 }}>
                {Array.from({ length: 12 }, (_, m) => (
                  <TouchableOpacity key={m} onPress={() => setMonth(m)} style={[styles.option, month === m && styles.optionActive]}>
                    <Text style={styles.optionText}>{pad(m + 1)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
            <View style={styles.column}>
              <Text style={styles.header}>Day</Text>
              <ScrollView style={{ maxHeight: 240 }}>
                {days.map((d) => (
                  <TouchableOpacity key={d} onPress={() => setDay(d)} style={[styles.option, day === d && styles.optionActive]}>
                    <Text style={styles.optionText}>{pad(d)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </View>
          <SheetFooter>
            <Button title="Cancel" variant="outline" onPress={() => setOpen(false)} />
            <Button title="Apply" onPress={apply} />
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

export function TimeField({ label, value, onChange, step = 5 }: { label: string; value: Date; onChange: (d: Date) => void; step?: number }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [hour, setHour] = useState(value.getHours());
  const [minute, setMinute] = useState(value.getMinutes() - (value.getMinutes() % step));

  const hours = useMemo(() => Array.from({ length: 24 }, (_, h) => h), []);
  const minutes = useMemo(() => Array.from({ length: Math.ceil(60 / step) }, (_, i) => i * step), [step]);

  const apply = () => {
    const updated = new Date(value);
    updated.setHours(hour);
    updated.setMinutes(minute);
    onChange(updated);
    setOpen(false);
  };

  const styles = StyleSheet.create({
    field: { minHeight: touchTargets.minimum, justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: colors.divider, borderRadius: radii.input, backgroundColor: colors.surface },
    fieldText: { color: colors.foreground },
    column: { flex: 1 },
    option: { minHeight: touchTargets.minimum, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 8, borderRadius: radii.input, marginBottom: 6 },
    optionActive: { backgroundColor: colors.primaryMuted, borderWidth: 1, borderColor: colors.primary },
    optionText: { textAlign: 'center', color: colors.foreground },
    header: { marginBottom: 8, color: colors.textSecondary },
    grid: { flexDirection: 'row', gap: 12 },
  });

  return (
    <>
      <TouchableOpacity onPress={() => setOpen(true)} style={styles.field}>
        <Text style={styles.fieldText}>{label}: {pad(value.getHours())}:{pad(value.getMinutes())}</Text>
      </TouchableOpacity>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent snapPoints={[0.95]} initialSnapPoint={0}>
          <SheetHeader>
            <SheetTitle>Select time</SheetTitle>
          </SheetHeader>
          <View style={styles.grid}>
            <View style={styles.column}>
              <Text style={styles.header}>Hour</Text>
              <ScrollView style={{ maxHeight: 240 }}>
                {hours.map((h) => (
                  <TouchableOpacity key={h} onPress={() => setHour(h)} style={[styles.option, hour === h && styles.optionActive]}>
                    <Text style={styles.optionText}>{pad(h)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
            <View style={styles.column}>
              <Text style={styles.header}>Minute</Text>
              <ScrollView style={{ maxHeight: 240 }}>
                {minutes.map((m) => (
                  <TouchableOpacity key={m} onPress={() => setMinute(m)} style={[styles.option, minute === m && styles.optionActive]}>
                    <Text style={styles.optionText}>{pad(m)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </View>
          <SheetFooter>
            <Button title="Cancel" variant="outline" onPress={() => setOpen(false)} />
            <Button title="Apply" onPress={apply} />
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
