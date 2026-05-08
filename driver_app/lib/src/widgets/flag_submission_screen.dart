import 'package:flutter/material.dart';

import '../l10n/app_strings.dart';
import '../models/driver_flag.dart';

class FlagSubmissionResult {
  const FlagSubmissionResult({
    required this.code,
    required this.reason,
  });

  final String code;
  final String reason;
}

class FlagSubmissionScreen extends StatefulWidget {
  const FlagSubmissionScreen({
    super.key,
    required this.options,
  });

  final List<DriverFlagOption> options;

  @override
  State<FlagSubmissionScreen> createState() => _FlagSubmissionScreenState();
}

class _FlagSubmissionScreenState extends State<FlagSubmissionScreen> {
  late final TextEditingController _reasonController;
  late String _selectedFlag;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reasonController = TextEditingController();
    _selectedFlag = widget.options.first.code;
  }

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  void _submit(AppStrings strings) {
    final String reason = _reasonController.text.trim();
    if (reason.isEmpty) {
      setState(() {
        _error = strings.tr('requiredReason', 'Reason is required.');
      });
      return;
    }

    Navigator.of(context).pop(
      FlagSubmissionResult(
        code: _selectedFlag,
        reason: reason,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AppStrings strings = AppStrings.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(strings.tr('flagTitle', 'New flag')),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: <Widget>[
            Text(
              strings.tr('flagTitle', 'New flag'),
              style: theme.textTheme.titleLarge,
            ),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              initialValue: _selectedFlag,
              decoration: InputDecoration(labelText: strings.tr('flagType', 'Flag type')),
              items: widget.options
                  .map(
                    (DriverFlagOption option) => DropdownMenuItem<String>(
                      value: option.code,
                      child: Text(strings.tr(option.labelKey, option.code)),
                    ),
                  )
                  .toList(),
              onChanged: (String? value) {
                setState(() {
                  _selectedFlag = value ?? _selectedFlag;
                });
              },
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _reasonController,
              minLines: 4,
              maxLines: 6,
              decoration: InputDecoration(
                labelText: strings.tr('flagReason', 'Reason'),
                errorText: _error,
              ),
            ),
            const SizedBox(height: 24),
            Row(
              children: <Widget>[
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                    child: Text(strings.tr('cancel', 'Cancel')),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton(
                    onPressed: () => _submit(strings),
                    child: Text(strings.tr('send', 'Send')),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
