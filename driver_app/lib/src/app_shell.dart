import 'package:flutter/material.dart';

import 'data/mock_driver_repository.dart';
import 'models/driver_task.dart';
import 'theme/app_theme.dart';
import 'widgets/active_task_screen.dart';
import 'widgets/login_screen.dart';
import 'widgets/task_board_screen.dart';

class RigSyncDriverApp extends StatefulWidget {
  const RigSyncDriverApp({super.key});

  @override
  State<RigSyncDriverApp> createState() => _RigSyncDriverAppState();
}

class _RigSyncDriverAppState extends State<RigSyncDriverApp> {
  final MockDriverRepository _repository = MockDriverRepository();

  String? _driverName;
  List<DriverTask> _tasks = <DriverTask>[];
  DriverTask? _activeTask;

  Future<void> _handleLogin(String email, String password) async {
    final loginResult = await _repository.login(email: email, password: password);
    final tasks = await _repository.fetchAssignedTasks();

    setState(() {
      _driverName = loginResult.driverName;
      _tasks = tasks;
      _activeTask = null;
    });
  }

  void _handleLogout() {
    setState(() {
      _driverName = null;
      _tasks = <DriverTask>[];
      _activeTask = null;
    });
  }

  void _handleOpenTask(DriverTask task) {
    setState(() {
      _activeTask = task;
    });
  }

  void _handleBackToTasks() {
    setState(() {
      _activeTask = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'RigSync Driver',
      theme: buildRigSyncTheme(),
      home: _driverName == null
          ? LoginScreen(
              onLogin: _handleLogin,
            )
          : _activeTask == null
              ? TaskBoardScreen(
                  driverName: _driverName!,
                  tasks: _tasks,
                  onLogout: _handleLogout,
                  onOpenTask: _handleOpenTask,
                )
              : ActiveTaskScreen(
                  task: _activeTask!,
                  driverName: _driverName!,
                  onBack: _handleBackToTasks,
                ),
    );
  }
}
