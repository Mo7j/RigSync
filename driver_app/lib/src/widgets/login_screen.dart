import 'package:flutter/material.dart';

import '../l10n/app_strings.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.onLogin,
    required this.onToggleLanguage,
  });

  final Future<void> Function(String email, String password) onLogin;
  final VoidCallback onToggleLanguage;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final TextEditingController _emailController = TextEditingController();
  final TextEditingController _passwordController = TextEditingController();
  bool _isSubmitting = false;
  String? _error;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _error = null;
    });

    try {
      await widget.onLogin(_emailController.text, _passwordController.text);
    } catch (error) {
      setState(() {
        _error = error.toString().replaceFirst('Exception: ', '');
      });
    } finally {
      if (mounted) {
        setState(() {
          _isSubmitting = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final AppStrings strings = AppStrings.of(context);

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Align(
                        alignment: AlignmentDirectional.centerEnd,
                        child: TextButton(
                          onPressed: widget.onToggleLanguage,
                          child: Text(strings.isArabic ? 'EN' : 'AR'),
                        ),
                      ),
                      Text(
                        strings.tr('appTitle', 'RigSync Driver'),
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: const Color(0xFFC6FF00),
                          letterSpacing: 1.2,
                        ),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        strings.tr('loginTitle', 'Driver login'),
                        style: theme.textTheme.displaySmall,
                      ),
                      const SizedBox(height: 10),
                      Text(
                        strings.tr('loginSubtitle', 'Sign in to see your current and upcoming tasks.'),
                        style: theme.textTheme.bodyLarge,
                      ),
                      const SizedBox(height: 24),
                      TextField(
                        controller: _emailController,
                        keyboardType: TextInputType.emailAddress,
                        decoration: InputDecoration(
                          labelText: strings.tr('email', 'Email'),
                          hintText: 'driver@rigsync.com',
                        ),
                      ),
                      const SizedBox(height: 14),
                      TextField(
                        controller: _passwordController,
                        obscureText: true,
                        decoration: InputDecoration(
                          labelText: strings.tr('password', 'Password'),
                          hintText: '******',
                        ),
                      ),
                      if (_error != null) ...<Widget>[
                        const SizedBox(height: 14),
                        Text(
                          _error!,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: const Color(0xFFFF7B7B),
                          ),
                        ),
                      ],
                      const SizedBox(height: 20),
                      SizedBox(
                        width: double.infinity,
                        child: ElevatedButton(
                          onPressed: _isSubmitting
                              ? null
                              : () {
                                  _submit();
                                },
                          child: Text(
                            _isSubmitting
                                ? strings.tr('loggingIn', 'Signing in...')
                                : strings.tr('login', 'Login'),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
