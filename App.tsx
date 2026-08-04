import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatDuration } from './src/core/clock';
import { buildReport, emptyDraft, validateDraft } from './src/core/report';
import { previewText, shortName, type ReportDraft, type ReportableEnvelope } from './src/core/types';
import { ControlPanel } from './src/experiment/ControlPanel';
import { ExperimentProvider, useExperiment } from './src/experiment/ExperimentContext';
import { ReportSheet } from './src/ui/ReportSheet';
import { theme } from './src/ui/theme';

function Room() {
  const { world, settings, now } = useExperiment();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReportDraft | null>(null);

  const target = world.envelopes().find((e) => e.id === targetId) ?? null;

  const issues = useMemo(() => {
    if (!target || !draft) return [];
    return validateDraft(draft, target, settings, {
      reporter: world.viewer,
      now,
      history: world.history(),
    });
  }, [target, draft, settings, now, world]);

  const open = (envelope: ReportableEnvelope) => {
    setTargetId(envelope.id);
    setDraft(emptyDraft(envelope.id));
  };

  const close = () => {
    setTargetId(null);
    setDraft(null);
    world.dispatch({ type: 'discard' });
  };

  const submit = () => {
    if (!target || !draft) return;
    const result = buildReport(draft, target, settings, {
      reporter: world.viewer,
      now,
      history: world.history(),
    });
    if (result.ok) world.accept(result.report);
  };

  return (
    <>
      <ScrollView style={styles.room} contentContainerStyle={styles.roomContent}>
        {world.envelopes().map((envelope) => {
          const hidden = world.isHidden(envelope.id);
          const own = envelope.sender === world.viewer;
          const expiresIn = envelope.expiresAt !== null ? envelope.expiresAt - now : null;

          if (hidden) {
            return (
              <View key={envelope.id} style={styles.hiddenRow}>
                <Text style={styles.hiddenText}>
                  Hidden after your report
                  {settings.hideOnReport.value === 'until_reviewed' ? ' · pending review' : ''}
                </Text>
                {settings.hideOnReport.value === 'local' && (
                  <Pressable onPress={() => world.unhide(envelope.id)}>
                    <Text style={styles.undo}>Show anyway</Text>
                  </Pressable>
                )}
              </View>
            );
          }

          return (
            <View key={envelope.id} style={[styles.row, own && styles.rowOwn]}>
              <Pressable
                onLongPress={() => open(envelope)}
                delayLongPress={280}
                style={({ pressed }) => [styles.bubble, own && styles.bubbleOwn, pressed && styles.bubblePressed]}
              >
                {!own && <Text style={styles.sender}>{shortName(envelope.sender)}</Text>}
                <Text style={styles.text}>{previewText(envelope)}</Text>
                <View style={styles.meta}>
                  {envelope.redactedAt !== undefined && <Text style={styles.metaWarn}>deleted</Text>}
                  {expiresIn !== null && (
                    <Text style={expiresIn <= 0 ? styles.metaWarn : styles.metaDim}>
                      {expiresIn <= 0 ? 'expired' : `expires in ${formatDuration(expiresIn)}`}
                    </Text>
                  )}
                  <Text style={styles.metaHint}>long press to report</Text>
                </View>
              </Pressable>
            </View>
          );
        })}
        {world.envelopes().length === 0 && <Text style={styles.empty}>No messages in this arrangement.</Text>}
      </ScrollView>

      {target && draft && (
        <ReportSheet
          visible
          subject={target}
          draft={draft}
          issues={issues}
          settings={settings}
          submission={world.submissionState()}
          now={now}
          onChange={(patch) => setDraft({ ...draft, ...patch })}
          onSubmit={submit}
          onRetry={() => world.dispatch({ type: 'retry', at: now })}
          onClose={close}
        />
      )}
    </>
  );
}

function Screen() {
  const insets = useSafeAreaInsets();
  const { scenario } = useExperiment();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>{scenario.title}</Text>
        <Text style={styles.subtitle}>{scenario.group}</Text>
      </View>
      <Room />
      <View style={{ paddingBottom: insets.bottom }}>
        <ControlPanel />
      </View>
      <StatusBar style="light" />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ExperimentProvider>
        <Screen />
      </ExperimentProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  subtitle: { color: theme.textFaint, fontSize: 11, marginTop: 2, textTransform: 'uppercase', letterSpacing: 1 },
  room: { flex: 1 },
  roomContent: { paddingVertical: 12 },
  row: { paddingHorizontal: 12, marginBottom: 8, alignItems: 'flex-start' },
  rowOwn: { alignItems: 'flex-end' },
  bubble: {
    maxWidth: '88%',
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    padding: 10,
  },
  bubbleOwn: { backgroundColor: theme.ownBubble, borderColor: '#2b4a72' },
  bubblePressed: { opacity: 0.7 },
  sender: { color: theme.accent, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  text: { color: theme.text, fontSize: 15, lineHeight: 20 },
  meta: { flexDirection: 'row', gap: 8, marginTop: 5, alignItems: 'center', flexWrap: 'wrap' },
  metaDim: { color: theme.textFaint, fontSize: 10 },
  metaWarn: { color: theme.warn, fontSize: 10 },
  metaHint: { color: theme.textFaint, fontSize: 10, fontStyle: 'italic' },
  hiddenRow: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: theme.radiusSm,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: theme.border,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  hiddenText: { color: theme.textFaint, fontSize: 12, fontStyle: 'italic', flex: 1 },
  undo: { color: theme.accent, fontSize: 12, fontWeight: '600' },
  empty: { color: theme.textFaint, textAlign: 'center', marginTop: 40, fontSize: 13 },
});
