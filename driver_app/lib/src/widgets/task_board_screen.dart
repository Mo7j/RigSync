import 'package:flutter/material.dart';

import '../l10n/app_strings.dart';
import '../models/driver_assignment.dart';

class TaskBoardScreen extends StatelessWidget {
  const TaskBoardScreen({
    super.key,
    required this.driverName,
    required this.driverStatus,
    required this.currentTasks,
    required this.upcomingTasks,
    required this.onLogout,
    required this.onToggleLanguage,
    required this.onOpenAssignment,
    required this.onSetAvailable,
    required this.onSetBusy,
  });

  final String driverName;
  final String driverStatus;
  final List<DriverAssignment> currentTasks;
  final List<DriverAssignment> upcomingTasks;
  final VoidCallback onLogout;
  final VoidCallback onToggleLanguage;
  final ValueChanged<DriverAssignment> onOpenAssignment;
  final Future<void> Function() onSetAvailable;
  final Future<void> Function() onSetBusy;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AppStrings strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 20,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(strings.tr('taskQueue', 'Task queue'), style: theme.textTheme.titleLarge),
            const SizedBox(height: 2),
            Text(driverName, style: theme.textTheme.bodyMedium),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: onToggleLanguage,
            child: Text(strings.isArabic ? 'EN' : 'AR'),
          ),
          TextButton(
            onPressed: onLogout,
            child: Text(strings.tr('logout', 'Logout')),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: <Widget>[
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color: const Color(0xFF11161D),
              borderRadius: BorderRadius.circular(26),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(strings.tr('assignedToYou', 'Assigned to you'), style: theme.textTheme.titleLarge),
                const SizedBox(height: 8),
                Text(
                  '${strings.tr('driverStatus', 'Driver status')}: ${_statusLabel(strings, driverStatus)}',
                  style: theme.textTheme.bodyMedium,
                ),
                const SizedBox(height: 16),
                Row(
                  children: <Widget>[
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () async {
                          await onSetAvailable();
                        },
                        child: Text(strings.tr('available', 'Available')),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () async {
                          await onSetBusy();
                        },
                        child: Text(strings.tr('busy', 'Busy')),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          _SectionTitle(title: strings.tr('currentTasks', 'Current tasks')),
          if (currentTasks.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(strings.tr('noCurrentTasks', 'No current tasks.'), style: theme.textTheme.bodyMedium),
            ),
          ...currentTasks.map((DriverAssignment assignment) => Padding(
                padding: const EdgeInsets.only(top: 12),
                child: _AssignmentCard(
                  assignment: assignment,
                  strings: strings,
                  onTap: () => onOpenAssignment(assignment),
                ),
              )),
          const SizedBox(height: 18),
          _SectionTitle(title: strings.tr('upcomingTasks', 'Upcoming tasks')),
          if (upcomingTasks.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(strings.tr('noUpcomingTasks', 'No upcoming tasks.'), style: theme.textTheme.bodyMedium),
            ),
          ...upcomingTasks.map((DriverAssignment assignment) => Padding(
                padding: const EdgeInsets.only(top: 12),
                child: _AssignmentCard(
                  assignment: assignment,
                  strings: strings,
                  onTap: () => onOpenAssignment(assignment),
                ),
              )),
        ],
      ),
    );
  }

  static String _statusLabel(AppStrings strings, String status) {
    switch (status) {
      case 'busy':
        return strings.tr('busy', 'Busy');
      case 'active':
        return strings.tr('active', 'Active');
      case 'offline':
        return strings.tr('offline', 'Offline');
      default:
        return strings.tr('available', 'Available');
    }
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Text(title, style: Theme.of(context).textTheme.titleLarge);
  }
}

class _AssignmentCard extends StatelessWidget {
  const _AssignmentCard({
    required this.assignment,
    required this.strings,
    required this.onTap,
  });

  final DriverAssignment assignment;
  final AppStrings strings;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final (_StatusPalette palette, String actionLabel) = switch (assignment.status) {
      AssignmentStatus.assigned => (const _StatusPalette(Color(0xFFC6FF00), Color(0x19C6FF00)), strings.tr('acceptAndStart', 'Accept and open map')),
      AssignmentStatus.accepted => (const _StatusPalette(Color(0xFF58D1FF), Color(0x2258D1FF)), strings.tr('openMap', 'Open map')),
      AssignmentStatus.active => (const _StatusPalette(Color(0xFF58D1FF), Color(0x2258D1FF)), strings.tr('openMap', 'Open map')),
      AssignmentStatus.paused => (const _StatusPalette(Color(0xFFFFD466), Color(0x22FFD466)), strings.tr('resumeTask', 'Resume task')),
      AssignmentStatus.completed => (const _StatusPalette(Color(0xFF8DA39C), Color(0x228DA39C)), strings.tr('taskDetails', 'Task details')),
      AssignmentStatus.queued => (const _StatusPalette(Color(0xFFFFB74D), Color(0x22FFB74D)), strings.tr('queuedTaskLocked', 'Waiting for current trip')),
    };

    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(26),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(assignment.moveName, style: theme.textTheme.titleLarge),
                        const SizedBox(height: 4),
                        Text(
                          assignment.tripLabel,
                          style: theme.textTheme.bodyMedium?.copyWith(color: Colors.white70),
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    decoration: BoxDecoration(
                      color: palette.background,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Text(
                      _statusLabel(strings, assignment.status),
                      style: theme.textTheme.bodyMedium?.copyWith(color: palette.foreground),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(_stageLabel(strings, assignment.currentStage), style: theme.textTheme.bodyLarge?.copyWith(color: Colors.white)),
              const SizedBox(height: 14),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: <Widget>[
                  SizedBox(width: 150, child: _MetaBlock(label: strings.tr('from', 'From'), value: assignment.startLabel)),
                  SizedBox(width: 150, child: _MetaBlock(label: strings.tr('to', 'To'), value: assignment.endLabel)),
                ],
              ),
              const SizedBox(height: 14),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: <Widget>[
                  SizedBox(
                    width: 110,
                    child: _MetaBlock(
                      label: strings.tr('trip', 'Trip'),
                      value: assignment.plannedTripCount > 0
                          ? '${assignment.tripNumber}/${assignment.plannedTripCount}'
                          : (assignment.tripNumber > 0 ? '${assignment.tripNumber}' : '--'),
                    ),
                  ),
                  SizedBox(
                    width: 130,
                    child: _MetaBlock(
                      label: strings.tr('load', 'Load'),
                      value: assignment.loadCode.isNotEmpty ? assignment.loadCode : '--',
                    ),
                  ),
                  SizedBox(width: 110, child: _MetaBlock(label: strings.tr('taskState', 'Task state'), value: _statusLabel(strings, assignment.status))),
                  SizedBox(width: 110, child: _MetaBlock(label: strings.tr('stage', 'Stage'), value: _stageLabel(strings, assignment.currentStage))),
                  SizedBox(width: 110, child: _MetaBlock(label: '#', value: '${assignment.sequence}')),
                ],
              ),
              const SizedBox(height: 18),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: onTap,
                  child: Text(actionLabel),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _statusLabel(AppStrings strings, AssignmentStatus status) {
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

  static String _stageLabel(AppStrings strings, AssignmentStage stage) {
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
}

class _MetaBlock extends StatelessWidget {
  const _MetaBlock({
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF171D26),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(label, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 6),
          Text(value, style: theme.textTheme.titleMedium?.copyWith(color: Colors.white)),
        ],
      ),
    );
  }
}

class _StatusPalette {
  const _StatusPalette(this.foreground, this.background);

  final Color foreground;
  final Color background;
}
