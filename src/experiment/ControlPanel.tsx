/**
 * Control panel. Same rule as the rest of the set: every room control sends a
 * state event. The NET tab is the simulated transport, which is not a room
 * setting and is kept visibly separate.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { MINUTE } from '../core/clock';
import { stateEvent } from '../core/roomState';
import {
  describeSource,
  STATE_REPORT,
  STATE_RETENTION,
  type HideBehavior,
  type Resolved,
} from '../core/settings';
import type { ReportDestination } from '../core/types';
import { theme } from '../ui/theme';
import { SCENARIOS } from './scenarios';
import { useExperiment } from './ExperimentContext';
import type { NetworkMode } from './world';

function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.chipPressed]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Row({ label, source, children }: { label: string; source?: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowControls}>{children}</View>
      {source && <Text style={styles.provenance}>← {source}</Text>}
    </View>
  );
}

const src = <T,>(r: Resolved<T>) => describeSource(r.source);

export function ControlPanel() {
  const { world, settings, warnings, scenario, setScenario, now } = useExperiment();
  const [tab, setTab] = useState<'scenario' | 'room' | 'net'>('scenario');

  const send = (patch: Record<string, unknown>) => {
    const current = world.stateStore.get(STATE_REPORT)?.content ?? {};
    world.stateStore.send(stateEvent(STATE_REPORT, { ...current, ...patch }, { originTs: now }));
  };

  return (
    <View style={styles.panel}>
      <View style={styles.tabs}>
        {(['scenario', 'room', 'net'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{t.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        {tab === 'scenario' && (
          <>
            <Text style={styles.question}>{scenario.question}</Text>
            {(['basics', 'evidence', 'limits', 'transport'] as const).map((group) => (
              <View key={group}>
                <Text style={styles.sectionLabel}>{group}</Text>
                <View style={styles.chipWrap}>
                  {SCENARIOS.filter((s) => s.group === group).map((s) => (
                    <Chip key={s.id} label={s.title} active={s.id === scenario.id} onPress={() => setScenario(s)} />
                  ))}
                </View>
              </View>
            ))}
            <Text style={styles.sectionLabel}>Expected</Text>
            {scenario.expect.map((line, i) => (
              <Text key={i} style={styles.expectLine}>
                • {line}
              </Text>
            ))}
            {scenario.tryNext?.map((line, i) => (
              <Text key={i} style={styles.tryLine}>
                → {line}
              </Text>
            ))}
          </>
        )}

        {tab === 'room' && (
          <>
            <Text style={styles.hint}>Every control here sends a room state event.</Text>

            <Row label="include_content_copy" source={src(settings.includeContentCopy)}>
              {[true, false].map((v) => (
                <Chip
                  key={String(v)}
                  label={v ? 'capture evidence' : 'reference only'}
                  active={settings.includeContentCopy.value === v}
                  onPress={() => send({ include_content_copy: v })}
                />
              ))}
            </Row>

            <Row label="destination" source={src(settings.destination)}>
              {(['room_moderators', 'homeserver', 'external_service'] as ReportDestination[]).map((v) => (
                <Chip
                  key={v}
                  label={v.replace(/_/g, ' ')}
                  active={settings.destination.value === v}
                  onPress={() => send({ destination: v })}
                />
              ))}
            </Row>

            <Row label="m.room.retention · max_lifetime" source={src(settings.retentionMaxLifetimeMs)}>
              {[
                { label: 'none', s: null },
                { label: '5m', s: 300 },
                { label: '1h', s: 3600 },
              ].map(({ label, s }) => (
                <Chip
                  key={label}
                  label={label}
                  active={
                    s === null
                      ? settings.retentionMaxLifetimeMs.value === null
                      : settings.retentionMaxLifetimeMs.value === s * 1000
                  }
                  onPress={() =>
                    s === null
                      ? world.stateStore.clear(STATE_RETENTION)
                      : world.stateStore.send(stateEvent(STATE_RETENTION, { max_lifetime: s }, { originTs: now }))
                  }
                />
              ))}
            </Row>

            <Row label="cooldown_ms" source={src(settings.cooldownMs)}>
              {[
                { label: 'off', ms: 0 },
                { label: '1m', ms: MINUTE },
                { label: '5m', ms: 5 * MINUTE },
              ].map(({ label, ms }) => (
                <Chip
                  key={label}
                  label={label}
                  active={settings.cooldownMs.value === ms}
                  onPress={() => send({ cooldown_ms: ms })}
                />
              ))}
            </Row>

            <Row label="hide_on_report" source={src(settings.hideOnReport)}>
              {(['never', 'local', 'until_reviewed'] as HideBehavior[]).map((v) => (
                <Chip
                  key={v}
                  label={v.replace('_', ' ')}
                  active={settings.hideOnReport.value === v}
                  onPress={() => send({ hide_on_report: v })}
                />
              ))}
            </Row>

            <Row label="allow_anonymous / allow_self_report">
              <Chip
                label={`anon ${settings.allowAnonymous.value ? 'on' : 'off'}`}
                active={settings.allowAnonymous.value}
                onPress={() => send({ allow_anonymous: !settings.allowAnonymous.value })}
              />
              <Chip
                label={`self ${settings.allowSelfReport.value ? 'on' : 'off'}`}
                active={settings.allowSelfReport.value}
                onPress={() => send({ allow_self_report: !settings.allowSelfReport.value })}
              />
            </Row>

            <Row label={`categories (${settings.categories.value.length})`} source={src(settings.categories)}>
              <Chip label="use defaults" onPress={() => send({ categories: null })} />
              <Chip
                label="room taxonomy"
                onPress={() =>
                  send({
                    categories: [
                      { id: 'off_topic', label: 'Off topic', severity: 'low' },
                      { id: 'unsourced', label: 'Unsourced claim', requires_note: true, severity: 'medium' },
                      { id: 'doxxing', label: 'Personal information', severity: 'high' },
                    ],
                  })
                }
              />
              <Chip label="send garbage" onPress={() => send({ categories: ['nope', { label: 'no id' }] })} />
              <Chip label="send empty" onPress={() => send({ categories: [] })} />
            </Row>

            <Row label="clock">
              {[
                { label: '+1m', ms: MINUTE },
                { label: '+5m', ms: 5 * MINUTE },
                { label: '+1h', ms: 60 * MINUTE },
              ].map(({ label, ms }) => (
                <Chip key={label} label={label} onPress={() => world.clock.advance(ms)} />
              ))}
            </Row>
          </>
        )}

        {tab === 'net' && (
          <>
            <Text style={styles.hint}>
              The transport, not a room setting. The submission machine exists for these cases.
            </Text>
            <Row label="network">
              {(['online', 'offline', 'server_error', 'rate_limited', 'rejects'] as NetworkMode[]).map((m) => (
                <Chip
                  key={m}
                  label={m.replace('_', ' ')}
                  active={world.network === m}
                  onPress={() => world.setNetwork(m)}
                />
              ))}
            </Row>
            <Row label={`report history (${world.history().length})`}>
              <Chip label="clear submission state" onPress={() => world.dispatch({ type: 'discard' })} />
            </Row>
            {world.history().map((r) => (
              <Text key={r.id} style={styles.historyLine}>
                {r.categoryId} on {r.subjectId} by {r.reporter ?? 'anonymous'}
              </Text>
            ))}
          </>
        )}

        {warnings.length > 0 && (
          <View style={styles.warnings}>
            <Text style={styles.warningTitle}>Resolver warnings</Text>
            {warnings.map((w, i) => (
              <Text key={i} style={[styles.warningLine, w.severity === 'danger' && styles.warningDanger]}>
                {w.setting}: {w.message}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: theme.surface, borderTopWidth: 1, borderTopColor: theme.border, maxHeight: '52%' },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: theme.border },
  tab: { flex: 1, paddingVertical: 9, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: theme.accent },
  tabText: { color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  tabTextActive: { color: theme.accent },
  body: { flexGrow: 0 },
  bodyContent: { padding: 12, paddingBottom: 24 },
  question: { color: theme.text, fontSize: 14, fontWeight: '600', marginBottom: 10, lineHeight: 19 },
  hint: { color: theme.textDim, fontSize: 11, marginBottom: 10, lineHeight: 15, fontStyle: 'italic' },
  sectionLabel: {
    color: theme.textFaint,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 12,
    marginBottom: 5,
  },
  expectLine: { color: theme.textDim, fontSize: 12, lineHeight: 17, marginBottom: 3 },
  tryLine: { color: theme.accent, fontSize: 12, lineHeight: 17, marginTop: 3 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
  },
  chipActive: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  chipPressed: { opacity: 0.6 },
  chipText: { color: theme.textDim, fontSize: 11 },
  chipTextActive: { color: theme.text, fontWeight: '700' },
  row: { marginBottom: 10 },
  rowLabel: { color: theme.text, fontSize: 11, fontWeight: '600', marginBottom: 5 },
  rowControls: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  provenance: { color: theme.textFaint, fontSize: 10, marginTop: 4, fontStyle: 'italic' },
  historyLine: { color: theme.textFaint, fontSize: 10, lineHeight: 14 },
  warnings: {
    marginTop: 12,
    padding: 9,
    borderRadius: theme.radiusSm,
    backgroundColor: '#2a1a1d',
    borderWidth: 1,
    borderColor: '#4a2b30',
  },
  warningTitle: { color: theme.danger, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  warningLine: { color: '#e0a0a6', fontSize: 11, lineHeight: 15 },
  warningDanger: { color: theme.danger, fontWeight: '700' },
});
