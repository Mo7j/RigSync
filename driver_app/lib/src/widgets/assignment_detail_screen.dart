import 'package:flutter/material.dart';

import '../l10n/app_strings.dart';
import '../models/driver_assignment.dart';
import '../models/driver_flag.dart';

class AssignmentDetailScreen extends StatefulWidget {
  const AssignmentDetailScreen({
    super.key,
    required this.assignment,
    required this.onBack,
    required this.onAccept,
    required this.onPause,
    required this.onResume,
    required this.onStartStage,
    required this.onCompleteStage,
    required this.onOpenTracking,
    required this.onSubmitFlag,
    required this.isSubmitting,
  });

  final DriverAssignment assignment;
  final VoidCallback onBack;
  final Future<void> Function() onAccept;
  final Future<void> Function() onPause;
  final Future<void> Function() onResume;
  final Future<void> Function() onStartStage;
  final Future<void> Function() onCompleteStage;
  final VoidCallback onOpenTracking;
  final Future<void> Function(String flagCode, String reason) onSubmitFlag;
  final bool isSubmitting;

  @override
  State<AssignmentDetailScreen> createState() => _AssignmentDetailScreenState();
}

class _AssignmentDetailScreenState extends State<AssignmentDetailScreen> {
  static const List<DriverFlagOption> _flagOptions = <DriverFlagOption>[
    DriverFlagOption(code: 'traffic', labelKey: 'flagTraffic'),
    DriverFlagOption(code: 'break', labelKey: 'flagBreak'),
    DriverFlagOption(code: 'prayer', labelKey: 'flagPrayer'),
    DriverFlagOption(code: 'mechanical', labelKey: 'flagMechanical'),
    DriverFlagOption(code: 'siteDelay', labelKey: 'flagSiteDelay'),
    DriverFlagOption(code: 'custom', labelKey: 'customFlag'),
  ];

  Future<void> _showFlagDialog() async {
    final TextEditingController reasonController = TextEditingController();
    String selectedFlag = _flagOptions.first.code;
    String? error;

    await showDialog<void>(
      context: context,
      builder: (BuildContext context) {
        return StatefulBuilder(
          builder: (BuildContext context, void Function(void Function()) setModalState) {
            final AppStrings strings = AppStrings.of(context);
            return AlertDialog(
              title: Text(strings.tr('flagTitle', 'New flag')),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  DropdownButtonFormField<String>(
                    value: selectedFlag,
                    decoration: InputDecoration(labelText: strings.tr('flagType', 'Flag type')),
                    items: _flagOptions
                        .map(
                          (DriverFlagOption option) => DropdownMenuItem<String>(
                            value: option.code,
                            child: Text(strings.tr(option.labelKey, option.code)),
                          ),
                        )
                        .toList(),
                    onChanged: (String? value) {
                      setModalState(() {
                        selectedFlag = value ?? selectedFlag;
                      });
                    },
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: reasonController,
                    minLines: 3,
                    maxLines: 5,
                    decoration: InputDecoration(labelText: strings.tr('flagReason', 'Reason')),
                  ),
                  if (error != null) ...<Widget>[
                    const SizedBox(height: 8),
                    Text(error!, style: const TextStyle(color: Color(0xFFFF7B7B))),
                  ],
                ],
              ),
              actions: <Widget>[
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: Text(strings.tr('cancel', 'Cancel')),
                ),
                ElevatedButton(
                  onPressed: () async {
                    final String reason = reasonController.text.trim();
                    if (reason.isEmpty) {
                      setModalState(() {
                        error = strings.tr('requiredReason', 'Reason is required.');
                      });
                      return;
                    }

                    final String flagCode = selectedFlag;
                    if (context.mounted) {
                      Navigator.of(context).pop();
                    }
                    try {
                      await widget.onSubmitFlag(flagCode, reason);
                      if (mounted) {
                        ScaffoldMessenger.of(this.context).showSnackBar(
                          SnackBar(content: Text(strings.tr('sendFlag', 'Send flag'))),
                        );
                      }
                    } catch (submitError) {
                      if (mounted) {
                        ScaffoldMessenger.of(this.context).showSnackBar(
                          SnackBar(
                            content: Text(
                              submitError.toString().replaceFirst('Exception: ', ''),
                            ),
                          ),
                        );
                      }
                    }
                  },
                  child: Text(strings.tr('send', 'Send')),
                ),
              ],
            );
          },
        );
      },
    );
    reasonController.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AppStrings strings = AppStrings.of(context);

    String stageLabel(AssignmentStage stage) {
      switch (stage) {
        case AssignmentStage.rigDown:
          return strings.tr('stageRigDown', 'Rig Down');
        case AssignmentStage.rigMove:
          return strings.tr('stageRigMove', 'Rig Move');
        case AssignmentStage.rigUp:
          return strings.tr('stageRigUp', 'Rig Up');
        case AssignmentStage.completed:
          return strings.tr('stageCompleted', 'Completed');
      }
    }

    String statusLabel(AssignmentStatus status) {
      switch (status) {
        case AssignmentStatus.assigned:
          return strings.tr('stateAssigned', 'Assigned');
        case AssignmentStatus.accepted:
          return strings.tr('stateAccepted', 'Accepted');
        case AssignmentStatus.active:
          return strings.tr('active', 'Active');
        case AssignmentStatus.paused:
          return strings.tr('statePaused', 'Paused');
        case AssignmentStatus.completed:
          return strings.tr('stateCompleted', 'Completed');
        case AssignmentStatus.queued:
          return strings.tr('stateQueued', 'Queued');
      }
    }

    final bool canAccept = widget.assignment.status == AssignmentStatus.assigned || widget.assignment.status == AssignmentStatus.queued;
    final bool canPause = widget.assignment.status == AssignmentStatus.accepted || widget.assignment.status == AssignmentStatus.active;
    final bool canResume = widget.assignment.status == AssignmentStatus.paused;
    final bool canTrack = widget.assignment.status != AssignmentStatus.completed;

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          onPressed: widget.onBack,
          icon: const Icon(Icons.arrow_back_rounded),
        ),
        title: Text(strings.tr('taskDetails', 'Task details')),
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: <Widget>[
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(widget.assignment.moveName, style: theme.textTheme.headlineMedium),
                  const SizedBox(height: 10),
                  _MetricRow(label: strings.tr('from', 'From'), value: widget.assignment.startLabel),
                  _MetricRow(label: strings.tr('to', 'To'), value: widget.assignment.endLabel),
                  _MetricRow(label: strings.tr('stage', 'Stage'), value: stageLabel(widget.assignment.currentStage)),
                  _MetricRow(label: strings.tr('taskState', 'Task state'), value: statusLabel(widget.assignment.status)),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          if (canAccept)
            ElevatedButton(
              onPressed: widget.isSubmitting
                  ? null
                  : () async {
                      await widget.onAccept();
                    },
              child: Text(strings.tr('acceptTask', 'Accept task')),
            ),
          if (canPause) ...<Widget>[
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: widget.isSubmitting
                  ? null
                  : () async {
                      await widget.onPause();
                    },
              child: Text(strings.tr('pauseTask', 'Pause task')),
            ),
          ],
          if (canResume) ...<Widget>[
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: widget.isSubmitting
                  ? null
                  : () async {
                      await widget.onResume();
                    },
              child: Text(strings.tr('resumeTask', 'Resume task')),
            ),
          ],
          if (widget.assignment.status != AssignmentStatus.completed) ...<Widget>[
            const SizedBox(height: 12),
            ElevatedButton(
              onPressed: widget.isSubmitting
                  ? null
                  : () async {
                      await widget.onStartStage();
                    },
              child: Text(strings.tr('startStage', 'Start stage')),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: widget.isSubmitting
                  ? null
                  : () async {
                      await widget.onCompleteStage();
                    },
              child: Text(strings.tr('completeStage', 'Complete stage')),
            ),
          ],
          if (canTrack) ...<Widget>[
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: widget.onOpenTracking,
              child: Text(strings.tr('openTracking', 'Open tracking')),
            ),
          ],
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: widget.isSubmitting ? null : _showFlagDialog,
            child: Text(strings.tr('sendFlag', 'Send flag')),
          ),
        ],
      ),
    );
  }
}

class _MetricRow extends StatelessWidget {
  const _MetricRow({
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Row(
        children: <Widget>[
          Expanded(child: Text(label, style: Theme.of(context).textTheme.bodyMedium)),
          Expanded(child: Text(value, textAlign: TextAlign.end, style: Theme.of(context).textTheme.titleMedium)),
        ],
      ),
    );
  }
}
