import 'package:flutter/material.dart';

import '../models/driver_task.dart';

class TaskBoardScreen extends StatelessWidget {
  const TaskBoardScreen({
    super.key,
    required this.driverName,
    required this.tasks,
    required this.onLogout,
    required this.onOpenTask,
  });

  final String driverName;
  final List<DriverTask> tasks;
  final VoidCallback onLogout;
  final ValueChanged<DriverTask> onOpenTask;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 20,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              'Assigned tasks',
              style: theme.textTheme.titleLarge,
            ),
            const SizedBox(height: 2),
            Text(
              driverName,
              style: theme.textTheme.bodyMedium,
            ),
          ],
        ),
        actions: <Widget>[
          TextButton(
            onPressed: onLogout,
            child: const Text('Logout'),
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
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        'Today''s route board',
                        style: theme.textTheme.titleLarge,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'View task details, start navigation, and keep dispatch updated with your live position.',
                        style: theme.textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: const Color(0x19C6FF00),
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Text(
                    '${tasks.length} tasks',
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: const Color(0xFFC6FF00),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          ...tasks.map(
            (DriverTask task) => Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: _TaskCard(
                task: task,
                onTap: () => onOpenTask(task),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TaskCard extends StatelessWidget {
  const _TaskCard({
    required this.task,
    required this.onTap,
  });

  final DriverTask task;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (_StatusPalette palette, String actionLabel) = switch (task.status) {
      DriverTaskStatus.pending => (const _StatusPalette(Color(0xFFFFB74D), Color(0x22FFB74D)), 'View task'),
      DriverTaskStatus.ready => (const _StatusPalette(Color(0xFFC6FF00), Color(0x19C6FF00)), 'Start task'),
      DriverTaskStatus.inProgress => (const _StatusPalette(Color(0xFF58D1FF), Color(0x2258D1FF)), 'Resume drive'),
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
                    child: Text(
                      task.title,
                      style: theme.textTheme.titleLarge,
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    decoration: BoxDecoration(
                      color: palette.background,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Text(
                      _statusLabel(task.status),
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: palette.foreground,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                task.assetName,
                style: theme.textTheme.bodyLarge?.copyWith(
                  color: Colors.white,
                ),
              ),
              const SizedBox(height: 14),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: <Widget>[
                  SizedBox(
                    width: 140,
                    child: _MetaBlock(
                      label: 'From',
                      value: task.origin.label,
                    ),
                  ),
                  SizedBox(
                    width: 140,
                    child: _MetaBlock(
                      label: 'To',
                      value: task.destination.label,
                    ),
                  ),
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
                      label: 'Window',
                      value: task.scheduledWindow,
                    ),
                  ),
                  SizedBox(
                    width: 110,
                    child: _MetaBlock(
                      label: 'ETA',
                      value: '${task.etaMinutes} min',
                    ),
                  ),
                  SizedBox(
                    width: 110,
                    child: _MetaBlock(
                      label: 'Distance',
                      value: '${task.totalDistanceKm} km',
                    ),
                  ),
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

  static String _statusLabel(DriverTaskStatus status) {
    return switch (status) {
      DriverTaskStatus.pending => 'Pending',
      DriverTaskStatus.ready => 'Ready',
      DriverTaskStatus.inProgress => 'In progress',
    };
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
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFF171D26),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label,
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 6),
          Text(
            value,
            style: theme.textTheme.titleMedium?.copyWith(
              color: Colors.white,
            ),
          ),
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
