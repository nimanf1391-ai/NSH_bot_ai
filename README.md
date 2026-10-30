# NSH.bot AI

نسخهٔ سروری NSH.bot با مدل open-weight از طریق API سازگار با OpenAI.

## ساختار پروژه
- `server.js`: سرور و API چت
- `package.json`: وابستگی‌ها و فرمان اجرا
- `public/index.html`: رابط کاربری NSH.bot
- `.env.example`: نمونهٔ متغیرهای محیطی (بدون کلید واقعی)

## استقرار روی Render
- Runtime: Node (اگر خودکار تشخیص داده شد، نیاز به انتخاب دستی نیست)
- Root Directory: خالی
- Build Command: `npm install`
- Start Command: `npm start`

Environment Variables:
- `GROQ_API_KEY`: کلید API سرویس‌دهنده؛ فقط در تنظیمات امن Render وارد شود.
- `AI_MODEL`: پیش‌فرض `openai/gpt-oss-20b`
- `MAX_REQUESTS_PER_MINUTE`: پیش‌فرض 8
- `TAVILY_API_KEY`: اختیاری؛ بدون آن جست‌وجوی وب غیرفعال است.

این پروژه خودش مدل را روی Render اجرا نمی‌کند؛ درخواست‌ها را به سرویس میزبانی مدل می‌فرستد. دسترسی رایگان، مدل‌های در دسترس و محدودیت‌ها ممکن است تغییر کنند. قبل از استفاده، شرایط و سقف مصرف سرویس‌دهنده را بررسی کنید.

هرگز کلید API را داخل HTML یا GitHub قرار ندهید. برای ساخت حساب سرویس‌دهنده و مدیریت کلیدها/هزینه‌ها، از والد یا سرپرست کمک بگیرید.
