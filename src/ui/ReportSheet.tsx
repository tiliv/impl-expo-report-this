/**
 * The report sheet.
 *
 * Two things it does that a plain form does not:
 *
 * 1. It shows **every** objection at once. Revealing them one at a time is how
 *    you get someone who gives up half way through reporting harassment.
 * 2. It separates errors from notices. "This expires in 4 minutes and the
 *    report will not include a copy" is information the user should have; it is
 *    not a reason to stop them sending.
 *
 * The evidence preview is deliberate too — if the report is going to carry a
 * copy of the content, the person sending it should see exactly what that copy
 * is before it leaves.
 */

import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { blocking, captureEvidence, findCategory, type Issue } from '../core/report';
import type { ReportSettings } from '../core/settings';
import { describeSubmission, type SubmissionState } from '../core/submission';
import { previewText, shortName, type ReportDraft, type ReportableEnvelope } from '../core/types';
import { theme } from './theme';

interface Props {
  visible: boolean;
  subject: ReportableEnvelope;
  draft: ReportDraft;
  issues: Issue[];
  settings: ReportSettings;
  submission: SubmissionState;
  now: number;
  onChange(patch: Partial<ReportDraft>): void;
  onSubmit(): void;
  onRetry(): void;
  onClose(): void;
}

export function ReportSheet({
  visible,
  subject,
  draft,
  issues,
  settings,
  submission,
  now,
  onChange,
  onSubmit,
  onRetry,
  onClose,
}: Props) {
  const errors = blocking(issues);
  const notices = issues.filter((i) => i.level === 'notice');
  const category = findCategory(settings, draft.categoryId);
  const inFlight = submission.status !== 'idle';
  const status = describeSubmission(submission);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.grabber} />

          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>Report this message</Text>

            <View style={styles.subject}>
              <Text style={styles.subjectSender}>{shortName(subject.sender)}</Text>
              <Text style={styles.subjectText} numberOfLines={3}>
                {previewText(subject)}
              </Text>
            </View>

            {inFlight ? (
              <View style={styles.statusBox}>
                <Text style={styles.statusTitle}>{status.title}</Text>
                <Text style={styles.statusDetail}>{status.detail}</Text>
                {(submission.status === 'queued' || submission.status === 'failed') && (
                  <Pressable style={styles.retry} onPress={onRetry}>
                    <Text style={styles.retryText}>Try again now</Text>
                  </Pressable>
                )}
                {submission.status === 'submitted' && (
                  <Pressable style={styles.retry} onPress={onClose}>
                    <Text style={styles.retryText}>Done</Text>
                  </Pressable>
                )}
              </View>
            ) : (
              <>
                <Text style={styles.label}>Reason</Text>
                <View style={styles.categories}>
                  {settings.categories.value.map((c) => {
                    const selected = c.id === draft.categoryId;
                    return (
                      <Pressable
                        key={c.id}
                        onPress={() => onChange({ categoryId: c.id })}
                        style={[styles.category, selected && styles.categorySelected]}
                      >
                        <View style={styles.categoryHead}>
                          <Text style={[styles.categoryLabel, selected && styles.categoryLabelSelected]}>
                            {c.label}
                          </Text>
                          <View style={[styles.severity, severityStyle(c.severity)]} />
                        </View>
                        {c.description && <Text style={styles.categoryDesc}>{c.description}</Text>}
                        {c.requiresNote && <Text style={styles.categoryNote}>needs a description</Text>}
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={styles.label}>
                  {category?.requiresNote ? 'What happened' : 'Anything to add (optional)'}
                </Text>
                <TextInput
                  style={styles.input}
                  value={draft.note}
                  onChangeText={(note) => onChange({ note })}
                  multiline
                  placeholder="Moderators will read this."
                  placeholderTextColor={theme.textFaint}
                  maxLength={settings.maxNoteChars.value + 200}
                />
                <Text style={styles.counter}>
                  {draft.note.length} / {settings.maxNoteChars.value}
                </Text>

                {settings.allowAnonymous.value && (
                  <Pressable style={styles.toggle} onPress={() => onChange({ anonymous: !draft.anonymous })}>
                    <View style={[styles.checkbox, draft.anonymous && styles.checkboxOn]}>
                      {draft.anonymous && <Text style={styles.checkGlyph}>✓</Text>}
                    </View>
                    <Text style={styles.toggleLabel}>Send without my name attached</Text>
                  </Pressable>
                )}

                <View style={styles.evidence}>
                  <Text style={styles.evidenceTitle}>
                    {settings.includeContentCopy.value ? 'This report will include' : 'This report will not include a copy'}
                  </Text>
                  {settings.includeContentCopy.value ? (
                    <Text style={styles.evidenceBody}>
                      "{captureEvidence(subject, now).contentSnapshot}"
                    </Text>
                  ) : (
                    <Text style={styles.evidenceBody}>
                      Only a reference to the message. If it is gone by the time a moderator looks,
                      they will see nothing.
                    </Text>
                  )}
                  <Text style={styles.evidenceMeta}>
                    Going to {settings.destination.value.replace(/_/g, ' ')}
                  </Text>
                </View>

                {notices.map((issue) => (
                  <View key={issue.code} style={styles.notice}>
                    <Text style={styles.noticeText}>{issue.message}</Text>
                  </View>
                ))}

                {errors.map((issue) => (
                  <View key={issue.code} style={styles.error}>
                    <Text style={styles.errorText}>{issue.message}</Text>
                  </View>
                ))}
              </>
            )}
          </ScrollView>

          {!inFlight && (
            <View style={styles.actions}>
              <Pressable style={styles.cancel} onPress={onClose}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.submit, errors.length > 0 && styles.submitDisabled]}
                onPress={onSubmit}
                disabled={errors.length > 0}
              >
                <Text style={styles.submitText}>Send report</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const severityStyle = (severity: 'low' | 'medium' | 'high') =>
  severity === 'high' ? styles.severityHigh : severity === 'medium' ? styles.severityMedium : styles.severityLow;

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000000bb', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    maxHeight: '92%',
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.border,
    alignSelf: 'center',
    marginTop: 8,
  },
  content: { padding: 16, paddingBottom: 8 },
  title: { color: theme.text, fontSize: 18, fontWeight: '700', marginBottom: 12 },
  subject: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 10,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: theme.danger,
    marginBottom: 16,
  },
  subjectSender: { color: theme.danger, fontSize: 12, fontWeight: '700', marginBottom: 3 },
  subjectText: { color: theme.textDim, fontSize: 13, lineHeight: 18 },
  label: { color: theme.text, fontSize: 13, fontWeight: '600', marginBottom: 8 },
  categories: { gap: 6, marginBottom: 16 },
  category: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceAlt,
    padding: 11,
  },
  categorySelected: { borderColor: theme.accent, backgroundColor: theme.accentDim },
  categoryHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  categoryLabel: { color: theme.text, fontSize: 14, fontWeight: '600', flex: 1 },
  categoryLabelSelected: { color: '#fff' },
  categoryDesc: { color: theme.textDim, fontSize: 12, marginTop: 3, lineHeight: 16 },
  categoryNote: { color: theme.warn, fontSize: 10, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  severity: { width: 8, height: 8, borderRadius: 4 },
  severityLow: { backgroundColor: theme.textFaint },
  severityMedium: { backgroundColor: theme.warn },
  severityHigh: { backgroundColor: theme.danger },
  input: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    fontSize: 14,
    padding: 11,
    minHeight: 86,
    textAlignVertical: 'top',
  },
  counter: { color: theme.textFaint, fontSize: 10, textAlign: 'right', marginTop: 4, marginBottom: 12 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  checkGlyph: { color: '#fff', fontSize: 12, fontWeight: '700' },
  toggleLabel: { color: theme.textDim, fontSize: 13 },
  evidence: {
    backgroundColor: theme.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 11,
    marginBottom: 12,
  },
  evidenceTitle: { color: theme.text, fontSize: 12, fontWeight: '700', marginBottom: 5 },
  evidenceBody: { color: theme.textDim, fontSize: 12, lineHeight: 17, fontStyle: 'italic' },
  evidenceMeta: { color: theme.textFaint, fontSize: 11, marginTop: 6 },
  notice: {
    backgroundColor: '#2a2318',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4a3a20',
    padding: 10,
    marginBottom: 8,
  },
  noticeText: { color: theme.warn, fontSize: 12, lineHeight: 17 },
  error: {
    backgroundColor: '#2a1a1d',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#4a2b30',
    padding: 10,
    marginBottom: 8,
  },
  errorText: { color: '#e0a0a6', fontSize: 12, lineHeight: 17 },
  statusBox: { alignItems: 'center', paddingVertical: 28, gap: 6 },
  statusTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  statusDetail: { color: theme.textDim, fontSize: 13, textAlign: 'center', paddingHorizontal: 20 },
  retry: {
    marginTop: 14,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: theme.accentDim,
  },
  retryText: { color: theme.text, fontSize: 13, fontWeight: '600' },
  actions: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  cancel: { flex: 1, paddingVertical: 13, borderRadius: 10, alignItems: 'center', backgroundColor: theme.surfaceAlt },
  cancelText: { color: theme.textDim, fontSize: 14, fontWeight: '600' },
  submit: { flex: 2, paddingVertical: 13, borderRadius: 10, alignItems: 'center', backgroundColor: theme.danger },
  submitDisabled: { opacity: 0.35 },
  submitText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
