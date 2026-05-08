import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:geolocator/geolocator.dart';
import 'dart:async';

import 'data/local_driver_repository.dart';
import 'l10n/app_strings.dart';
import 'models/driver_assignment.dart';
import 'models/driver_session.dart';
import 'models/telemetry_snapshot.dart';
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
  final LocalDriverRepository _repository = LocalDriverRepository();
  Timer? _assignmentRefreshTimer;
  late String _languageCode;

  DriverSession? _session;
  List<DriverAssignment> _assignments = <DriverAssignment>[];
  DriverAssignment? _selectedAssignment;
  bool _isSubmitting = false;

  @override
  void initState() {
    super.initState();
    final String platformCode = WidgetsBinding.instance.platformDispatcher.locale.languageCode.toLowerCase();
    _languageCode = platformCode == 'ar' ? 'ar' : 'en';
  }

  Future<void> _handleLogin(String email, String password) async {
    final (DriverSession session, List<DriverAssignment> assignments) = await _repository.login(
      email: email,
      password: password,
    );
    setState(() {
      _session = session;
      _assignments = _normalizeAssignmentQueue(assignments);
      _selectedAssignment = null;
    });
    _startAssignmentRefresh();

    unawaited(() async {
      Position? position;
      try {
        position = await Geolocator.getCurrentPosition();
      } catch (_) {
        position = null;
      }

      DriverSession nextSession = session;
      if (position != null) {
        try {
          nextSession = await _repository.updateStatus(
            session: session,
            currentStatus: session.currentStatus,
            telemetry: TelemetrySnapshot(
              latitude: position.latitude,
              longitude: position.longitude,
              speedKph: position.speed.isFinite ? position.speed * 3.6 : 0,
              recordedAt: DateTime.now(),
            ),
          );
        } catch (_) {
          nextSession = session;
        }
      }

      if (!mounted) {
        return;
      }
      setState(() {
        _session = nextSession;
      });
    }());
  }

  void _handleLogout() {
    _assignmentRefreshTimer?.cancel();
    setState(() {
      _session = null;
      _assignments = <DriverAssignment>[];
      _selectedAssignment = null;
    });
  }

  void _handleOpenAssignment(DriverAssignment assignment) {
    setState(() {
      _selectedAssignment = assignment;
    });
  }

  void _handleBackToQueue() {
    setState(() {
      _selectedAssignment = null;
    });
  }

  @override
  void dispose() {
    _assignmentRefreshTimer?.cancel();
    super.dispose();
  }

  void _startAssignmentRefresh() {
    _assignmentRefreshTimer?.cancel();
    _assignmentRefreshTimer = Timer.periodic(const Duration(seconds: 15), (_) async {
      final DriverSession? session = _session;
      if (session == null || _isSubmitting) {
        return;
      }
      try {
        final List<DriverAssignment> assignments = await _repository.fetchAssignments(session: session);
        if (!mounted) {
          return;
        }
        final List<DriverAssignment> mergedAssignments = _mergeOptimisticAssignments(
          optimisticAssignments: _assignments,
          nextAssignments: assignments,
        );
        final List<DriverAssignment> normalizedAssignments = _normalizeAssignmentQueue(mergedAssignments);
        setState(() {
          _assignments = normalizedAssignments;
          _selectedAssignment = _resolveSelectionAfterOptimisticUpdate(
            previousSelected: _selectedAssignment,
            nextAssignments: normalizedAssignments,
          );
        });
      } catch (_) {
        // Keep the last successful queue if refresh fails.
      }
    });
  }

  DriverAssignment? get _resolvedSelectedAssignment {
    final String? targetId = _selectedAssignment?.id;
    if (targetId == null) {
      return null;
    }
    for (final DriverAssignment assignment in _assignments) {
      if (assignment.id == targetId) {
        if (assignment.status == AssignmentStatus.completed || assignment.status == AssignmentStatus.queued) {
          return null;
        }
        return assignment;
      }
    }
    return null;
  }

  Future<TelemetrySnapshot?> _readTelemetry() async {
    try {
      final Position position = await Geolocator.getCurrentPosition();
      return TelemetrySnapshot(
        latitude: position.latitude,
        longitude: position.longitude,
        speedKph: position.speed.isFinite ? position.speed * 3.6 : 0,
        recordedAt: DateTime.now(),
      );
    } catch (_) {
      return null;
    }
  }

  Future<void> _setManualStatus(String status) async {
    final DriverSession? session = _session;
    if (session == null) {
      return;
    }
    final DriverSession nextSession = await _repository.updateStatus(
      session: session,
      currentStatus: status,
    );
    setState(() {
      _session = nextSession;
    });
  }

  void _toggleLanguage() {
    setState(() {
      _languageCode = _languageCode == 'ar' ? 'en' : 'ar';
    });
  }

  String _stageApiValue(AssignmentStage stage) {
    switch (stage) {
      case AssignmentStage.rigDown:
        return 'rigDown';
      case AssignmentStage.rigMove:
        return 'rigMove';
      case AssignmentStage.rigUp:
        return 'rigUp';
      case AssignmentStage.completed:
        return 'completed';
    }
  }

  Future<void> _submitAssignmentEvent({
    required DriverAssignment assignment,
    required String type,
    TelemetrySnapshot? telemetry,
    Map<String, dynamic>? flag,
  }) async {
    final DriverSession? session = _session;
    if (session == null) {
      return;
    }

    setState(() {
      _isSubmitting = true;
    });

    final List<DriverAssignment> previousAssignments = List<DriverAssignment>.from(_assignments);
    final DriverAssignment? previousSelected = _selectedAssignment;
    final bool isFinalStageCompletion = type == 'stageCompleted' && assignment.currentStage == AssignmentStage.rigUp;

    try {
      final List<DriverAssignment> optimisticAssignments = _normalizeAssignmentQueue(_optimisticAssignmentsForEvent(
        assignment: assignment,
        type: type,
      ));
      if (optimisticAssignments.isNotEmpty) {
        setState(() {
          _assignments = optimisticAssignments;
          _selectedAssignment = isFinalStageCompletion
              ? null
              : _resolveSelectionAfterOptimisticUpdate(
                  previousSelected: previousSelected,
                  nextAssignments: optimisticAssignments,
                );
        });
      }

      final (DriverSession nextSession, List<DriverAssignment> nextAssignments) = await _repository.submitEvent(
        session: session,
        assignment: assignment,
        type: type,
        stage: _stageApiValue(assignment.currentStage),
        telemetry: telemetry,
        flag: flag,
      );
      final List<DriverAssignment> mergedAssignments = _normalizeAssignmentQueue(_mergeOptimisticAssignments(
        optimisticAssignments: optimisticAssignments,
        nextAssignments: nextAssignments,
      ));

      setState(() {
        _session = nextSession;
        _assignments = mergedAssignments;
        if (isFinalStageCompletion) {
          _selectedAssignment = null;
        } else {
          final String? selectedId = _selectedAssignment?.id;
          if (selectedId != null) {
            DriverAssignment? nextSelected;
            for (final DriverAssignment candidate in mergedAssignments) {
              if (candidate.id == selectedId) {
                if (candidate.status != AssignmentStatus.completed && candidate.status != AssignmentStatus.queued) {
                  nextSelected = candidate;
                }
                break;
              }
            }
            _selectedAssignment = nextSelected;
          }
        }
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _assignments = previousAssignments;
          _selectedAssignment = previousSelected;
        });
      }
      rethrow;
    } finally {
      if (mounted) {
        setState(() {
          _isSubmitting = false;
        });
      }
    }
  }

  Future<void> _handleAccept(DriverAssignment assignment) async {
    await _submitAssignmentEvent(assignment: assignment, type: 'accepted');
  }

  Future<void> _handlePause(DriverAssignment assignment) async {
    await _submitAssignmentEvent(assignment: assignment, type: 'paused');
  }

  Future<void> _handleResume(DriverAssignment assignment) async {
    await _submitAssignmentEvent(assignment: assignment, type: 'resumed');
  }

  Future<void> _handleStartStage(
    DriverAssignment assignment, {
    TelemetrySnapshot? telemetry,
  }) async {
    await _submitAssignmentEvent(
      assignment: assignment,
      type: 'stageStarted',
      telemetry: telemetry ?? await _readTelemetry(),
    );
  }

  Future<void> _handleCompleteStage(
    DriverAssignment assignment, {
    TelemetrySnapshot? telemetry,
  }) async {
    await _submitAssignmentEvent(
      assignment: assignment,
      type: 'stageCompleted',
      telemetry: telemetry ?? await _readTelemetry(),
    );
  }

  Future<void> _handleAcceptAndOpenMap(DriverAssignment assignment) async {
    setState(() {
      _assignments = _normalizeAssignmentQueue(_assignments.map((DriverAssignment item) {
        if (item.id != assignment.id) {
          return item;
        }
        return item.copyWith(
          status: AssignmentStatus.accepted,
          updatedAt: DateTime.now(),
        );
      }).toList());
      _selectedAssignment = assignment.copyWith(
        status: AssignmentStatus.accepted,
        updatedAt: DateTime.now(),
      );
    });
    await _handleAccept(assignment);
  }

  Future<void> _handleFlag(DriverAssignment assignment, String flagCode, String reason) async {
    final DriverAssignment latestAssignment = _resolvedSelectedAssignment ?? assignment;
    await _submitAssignmentEvent(
      assignment: latestAssignment,
      type: 'flagSubmitted',
      flag: <String, dynamic>{
        'type': flagCode,
        'label': flagCode,
        'reason': reason,
      },
    );
  }

  Future<void> _handleTelemetry(TelemetrySnapshot telemetry) async {
    final DriverSession? session = _session;
    final DriverAssignment? assignment = _resolvedSelectedAssignment;
    if (session == null || assignment == null) {
      return;
    }

    final String autoStatus = assignment.currentStage == AssignmentStage.rigMove ? 'active' : 'busy';
    final Future<DriverSession> statusFuture = _repository.updateStatus(
      session: session,
      currentStatus: autoStatus,
      telemetry: telemetry,
    );
    final Future<void> telemetryFuture = _repository.sendTelemetry(
      session: session,
      assignment: assignment,
      telemetry: telemetry,
    );
    final DriverSession nextSession = await statusFuture;
    unawaited(
      telemetryFuture.catchError((Object _) {
        // Keep local navigation responsive even if telemetry upload fails.
      }),
    );

    if (mounted) {
      setState(() {
        _session = nextSession;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final DriverAssignment? selectedAssignment = _resolvedSelectedAssignment;
    final List<DriverAssignment> currentAssignments = _assignments.where((DriverAssignment item) => item.isCurrent).toList();
    final List<DriverAssignment> upcomingAssignments = _assignments.where((DriverAssignment item) => item.isUpcoming).toList();

    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'RigSync Driver',
      theme: buildRigSyncTheme(),
      locale: Locale(_languageCode),
      supportedLocales: const <Locale>[Locale('en'), Locale('ar')],
      localeResolutionCallback: (Locale? locale, Iterable<Locale> supportedLocales) {
        final String languageCode = locale?.languageCode.toLowerCase() ?? 'en';
        if (languageCode == 'ar') {
          return const Locale('ar');
        }
        return const Locale('en');
      },
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: _session == null
          ? LoginScreen(
              onLogin: _handleLogin,
              onToggleLanguage: _toggleLanguage,
            )
          : selectedAssignment == null
              ? TaskBoardScreen(
                  driverName: _session!.name,
                  driverStatus: _session!.currentStatus,
                  currentTasks: currentAssignments,
                  upcomingTasks: upcomingAssignments,
                  onLogout: _handleLogout,
                  onToggleLanguage: _toggleLanguage,
                  onOpenAssignment: (DriverAssignment assignment) async {
                    if (assignment.status == AssignmentStatus.queued) {
                      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                        SnackBar(
                          content: Text(
                            AppStrings.of(context).tr(
                              'queuedTaskLocked',
                              'This trip will unlock after the current task is completed.',
                            ),
                          ),
                        ),
                      );
                      return;
                    }
                    if (assignment.status == AssignmentStatus.assigned) {
                      await _handleAcceptAndOpenMap(assignment);
                      return;
                    }
                    _handleOpenAssignment(assignment);
                  },
                  onSetAvailable: () => _setManualStatus('available'),
                  onSetBusy: () => _setManualStatus('busy'),
                )
              : ActiveTaskScreen(
                  assignment: selectedAssignment,
                  onBack: _handleBackToQueue,
                  onToggleLanguage: _toggleLanguage,
                  onTelemetry: _handleTelemetry,
                  onPause: () => _handlePause(selectedAssignment),
                  onResume: () => _handleResume(selectedAssignment),
                  onAccept: () => _handleAccept(selectedAssignment),
                  onPrimaryAction: (TelemetrySnapshot? telemetry) async {
                    final DriverAssignment? latest = _resolvedSelectedAssignment;
                    if (latest == null) {
                      return;
                    }
                    if (latest.status == AssignmentStatus.paused) {
                      await _handleResume(latest);
                      return;
                    }
                    if (latest.status == AssignmentStatus.queued) {
                      return;
                    }
                    if (latest.currentStage == AssignmentStage.rigDown && latest.status == AssignmentStatus.assigned) {
                      await _handleAccept(latest);
                      return;
                    }
                    await _handleCompleteStage(latest, telemetry: telemetry);
                  },
                  onSubmitFlag: (String flagCode, String reason) => _handleFlag(selectedAssignment, flagCode, reason),
                  isSubmitting: _isSubmitting,
                ),
    );
  }

  List<DriverAssignment> _optimisticAssignmentsForEvent({
    required DriverAssignment assignment,
    required String type,
  }) {
    if (_assignments.isEmpty) {
      return _assignments;
    }

    return _assignments.map((DriverAssignment item) {
      if (item.id != assignment.id) {
        return item;
      }
      switch (type) {
        case 'accepted':
          return item.copyWith(status: AssignmentStatus.accepted, updatedAt: DateTime.now());
        case 'paused':
          return item.copyWith(status: AssignmentStatus.paused, updatedAt: DateTime.now());
        case 'resumed':
          return item.copyWith(
            status: item.currentStage == AssignmentStage.rigMove ? AssignmentStatus.active : AssignmentStatus.accepted,
            updatedAt: DateTime.now(),
          );
        case 'stageCompleted':
          if (item.currentStage == AssignmentStage.rigDown) {
            return item.copyWith(
              currentStage: AssignmentStage.rigMove,
              status: AssignmentStatus.active,
              updatedAt: DateTime.now(),
            );
          }
          if (item.currentStage == AssignmentStage.rigMove) {
            return item.copyWith(
              currentStage: AssignmentStage.rigUp,
              status: AssignmentStatus.accepted,
              updatedAt: DateTime.now(),
            );
          }
          if (item.currentStage == AssignmentStage.rigUp) {
            return item.copyWith(
              currentStage: AssignmentStage.completed,
              status: AssignmentStatus.completed,
              updatedAt: DateTime.now(),
            );
          }
          return item;
        case 'flagSubmitted':
          return item.copyWith(
            updatedAt: DateTime.now(),
          );
        default:
          return item;
      }
    }).toList();
  }

  DriverAssignment? _resolveSelectionAfterOptimisticUpdate({
    required DriverAssignment? previousSelected,
    required List<DriverAssignment> nextAssignments,
  }) {
    final String? selectedId = previousSelected?.id;
    if (selectedId == null) {
      return null;
    }
    for (final DriverAssignment candidate in nextAssignments) {
      if (candidate.id == selectedId) {
        if (candidate.status == AssignmentStatus.completed || candidate.status == AssignmentStatus.queued) {
          return null;
        }
        return candidate;
      }
    }
    return null;
  }

  List<DriverAssignment> _mergeOptimisticAssignments({
    required List<DriverAssignment> optimisticAssignments,
    required List<DriverAssignment> nextAssignments,
  }) {
    if (optimisticAssignments.isEmpty) {
      return nextAssignments;
    }
    final Map<String, DriverAssignment> optimisticById = <String, DriverAssignment>{
      for (final DriverAssignment assignment in optimisticAssignments) assignment.id: assignment,
    };

    final List<DriverAssignment> merged = nextAssignments.map((DriverAssignment serverAssignment) {
      final DriverAssignment? optimistic = optimisticById[serverAssignment.id];
      if (optimistic == null) {
        return serverAssignment;
      }
      if (_assignmentProgressRank(optimistic) > _assignmentProgressRank(serverAssignment)) {
        return optimistic;
      }
      if (_assignmentProgressRank(optimistic) == _assignmentProgressRank(serverAssignment)) {
        final DateTime optimisticUpdatedAt = optimistic.updatedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
        final DateTime serverUpdatedAt = serverAssignment.updatedAt ?? DateTime.fromMillisecondsSinceEpoch(0);
        if (optimisticUpdatedAt.isAfter(serverUpdatedAt)) {
          return optimistic;
        }
      }
      return serverAssignment;
    }).toList();

    final Set<String> mergedIds = merged.map((DriverAssignment item) => item.id).toSet();
    for (final DriverAssignment optimistic in optimisticAssignments) {
      if (!mergedIds.contains(optimistic.id) && optimistic.status != AssignmentStatus.completed) {
        merged.add(optimistic);
      }
    }

    merged.sort((DriverAssignment left, DriverAssignment right) {
      final int currentOrder = left.isCurrent == right.isCurrent ? 0 : (left.isCurrent ? -1 : 1);
      if (currentOrder != 0) {
        return currentOrder;
      }
      return left.sequence.compareTo(right.sequence);
    });
    return merged;
  }

  List<DriverAssignment> _normalizeAssignmentQueue(List<DriverAssignment> assignments) {
    final List<DriverAssignment> ordered = List<DriverAssignment>.from(assignments)
      ..sort((DriverAssignment left, DriverAssignment right) {
        final int progressOrder = _assignmentProgressRank(right).compareTo(_assignmentProgressRank(left));
        if (progressOrder != 0) {
          return progressOrder;
        }
        final int sequenceOrder = left.sequence.compareTo(right.sequence);
        if (sequenceOrder != 0) {
          return sequenceOrder;
        }
        return (left.assignedAt ?? DateTime.fromMillisecondsSinceEpoch(0))
            .compareTo(right.assignedAt ?? DateTime.fromMillisecondsSinceEpoch(0));
      });

    bool hasCurrentTask = false;
    final List<DriverAssignment> normalized = ordered.map((DriverAssignment assignment) {
      if (assignment.status == AssignmentStatus.completed) {
        return assignment;
      }

      final bool isActionable = assignment.status == AssignmentStatus.assigned
          || assignment.status == AssignmentStatus.accepted
          || assignment.status == AssignmentStatus.active
          || assignment.status == AssignmentStatus.paused;
      if (!isActionable) {
        return assignment;
      }

      if (!hasCurrentTask) {
        hasCurrentTask = true;
        return assignment;
      }

      return assignment.copyWith(status: AssignmentStatus.queued);
    }).toList();

    normalized.sort((DriverAssignment left, DriverAssignment right) {
      final int currentOrder = left.isCurrent == right.isCurrent ? 0 : (left.isCurrent ? -1 : 1);
      if (currentOrder != 0) {
        return currentOrder;
      }
      return left.sequence.compareTo(right.sequence);
    });
    return normalized;
  }

  int _assignmentProgressRank(DriverAssignment assignment) {
    final int stageRank = switch (assignment.currentStage) {
      AssignmentStage.rigDown => 1,
      AssignmentStage.rigMove => 2,
      AssignmentStage.rigUp => 3,
      AssignmentStage.completed => 4,
    };
    final int statusRank = switch (assignment.status) {
      AssignmentStatus.queued => 0,
      AssignmentStatus.assigned => 1,
      AssignmentStatus.accepted => 2,
      AssignmentStatus.active => 3,
      AssignmentStatus.paused => 4,
      AssignmentStatus.completed => 5,
    };
    return (stageRank * 10) + statusRank;
  }
}
