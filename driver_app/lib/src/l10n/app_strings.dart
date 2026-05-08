import 'dart:ui';

import 'package:flutter/widgets.dart';

class AppStrings {
  AppStrings(this.languageCode);

  final String languageCode;

  bool get isArabic => languageCode == 'ar';
  TextDirection get textDirection => isArabic ? TextDirection.rtl : TextDirection.ltr;

  static AppStrings of(BuildContext context) {
    final String code = Localizations.localeOf(context).languageCode.toLowerCase();
    return AppStrings(code == 'ar' ? 'ar' : 'en');
  }

  String tr(String key, String fallback) {
    return _translations[languageCode]?[key] ?? fallback;
  }

  static const Map<String, Map<String, String>> _translations = <String, Map<String, String>>{
    'ar': <String, String>{
      'appTitle': 'ريج سينك للسائق',
      'loginTitle': 'تسجيل دخول السائق',
      'loginSubtitle': 'سجّل الدخول لعرض المهام الحالية والقادمة.',
      'email': 'البريد الإلكتروني',
      'password': 'كلمة المرور',
      'login': 'تسجيل الدخول',
      'loggingIn': 'جارٍ تسجيل الدخول...',
      'logout': 'تسجيل الخروج',
      'taskQueue': 'قائمة المهام',
      'currentTasks': 'المهام الحالية',
      'upcomingTasks': 'المهام القادمة',
      'noCurrentTasks': 'لا توجد مهام حالية.',
      'noUpcomingTasks': 'لا توجد مهام قادمة.',
      'available': 'متاح',
      'busy': 'مشغول',
      'active': 'نشط',
      'offline': 'غير متصل',
      'driverStatus': 'حالة السائق',
      'assignedToYou': 'المهام المسندة لك',
      'openTask': 'فتح المهمة',
      'openMap': 'فتح الخريطة',
      'acceptAndStart': 'قبول وفتح الخريطة',
      'taskDetails': 'تفاصيل المهمة',
      'move': 'النقلة',
      'from': 'من',
      'to': 'إلى',
      'stage': 'المرحلة',
      'taskState': 'حالة المهمة',
      'acceptTask': 'قبول المهمة',
      'pauseTask': 'إيقاف مؤقت',
      'resumeTask': 'استئناف',
      'openTracking': 'فتح التتبع',
      'sendFlag': 'إرسال بلاغ',
      'startStage': 'بدء المرحلة',
      'completeStage': 'إنهاء المرحلة',
      'back': 'رجوع',
      'gpsWaiting': 'بانتظار GPS',
      'speed': 'السرعة',
      'kmh': 'كم/س',
      'distance': 'المسافة',
      'km': 'كم',
      'eta': 'الوقت المتوقع',
      'flagTitle': 'بلاغ جديد',
      'flagType': 'نوع البلاغ',
      'flagReason': 'السبب',
      'customFlag': 'بلاغ مخصص',
      'send': 'إرسال',
      'cancel': 'إلغاء',
      'requiredReason': 'السبب مطلوب.',
      'telemetry': 'التتبع المباشر',
      'close': 'إغلاق',
      'refresh': 'تحديث',
      'stageRigDown': 'فك البرج',
      'stageRigMove': 'نقل البرج',
      'stageRigUp': 'تركيب البرج',
      'stageCompleted': 'مكتمل',
      'stateAssigned': 'مسندة',
      'stateAccepted': 'مقبولة',
      'stateQueued': 'في الانتظار',
      'statePaused': 'متوقفة',
      'stateCompleted': 'مكتملة',
      'taskStateCard': 'حالة المهمة',
      'flagTraffic': 'تأخير مروري',
      'flagBreak': 'استراحة',
      'flagPrayer': 'صلاة',
      'flagMechanical': 'عطل ميكانيكي',
      'flagSiteDelay': 'تأخير بالموقع',
      'minutesShort': 'د',
      'hoursShort': 'س',
      'pickedUp': 'تم الاستلام',
      'arrivedDestination': 'تم الوصول إلى الوجهة',
      'completeTask': 'إكمال المهمة',
      'done': 'تم',
      'routeToPickup': 'المسار إلى موقع الاستلام',
      'routeToDestination': 'المسار إلى الوجهة',
      'atDestination': 'عند الوجهة',
      'taskCompleted': 'اكتملت المهمة',
      'stateActive': 'نشطة',
      'source': 'المصدر',
      'destination': 'الوجهة',
      'driver': 'السائق',
      'truckType': 'نوع الشاحنة',
      'route': 'المسار',
      'minutes': 'دقيقة',
      'hours': 'ساعة',
    },
  };
}
