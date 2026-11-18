# منصة براعم عمران

تطبيق ويب تقدمي (PWA) متجاوب لإدارة الحلقات القرآنية والمجمعات والمساجد، مبني بـ React و TypeScript و Tailwind CSS و Firebase، ومهيأ للنشر التلقائي على **GitHub Pages**.

---

## خطوات الرفع والاستضافة على GitHub Pages

### 1. رفع المشروع إلى مستودع GitHub
```bash
git init
git add .
git commit -m "تهيئة منصة براعم عمران للنشر على GitHub Pages"
git branch -M main
git remote add origin https://github.com/<اسم-المستخدم>/<اسم-المستودع>.git
git push -u origin main
```

### 2. تفعيل استضافة GitHub Pages
1. افتح مستودعك على GitHub وانتقل إلى **Settings** ← **Pages**.
2. في قسم **Build and deployment** اختر **Source: GitHub Actions**.
3. عند الدفع إلى فرع `main` (أو تشغيل Workflow يدوياً من تبويب **Actions**)، سيتم بناء المشروع تلقائياً ونشره على الرابط:
   `https://<اسم-المستخدم>.github.io/<اسم-المستودع>/`

> يتعرف ملف `.github/workflows/deploy.yml` تلقائياً على اسم المستودع ويضبط مسار التطبيق (`VITE_BASE_PATH`) والـ PWA وملف `404.html` دون أي تعديل يدوي.

### 3. تفعيل تسجيل الدخول بجوجل على رابط GitHub Pages (مهم جداً)
لأن تسجيل الدخول يعتمد على Firebase Authentication:
1. افتح **Firebase Console** لمشروعك الأساسي (ولأي مشروع Firebase خارجي مرتبط).
2. انتقل إلى **Authentication** ← **Settings** ← **Authorized domains**.
3. اضغط **Add domain** وأضف نطاق استضافتك على GitHub، مثال:
   `<اسم-المستخدم>.github.io`

---

## التشغيل والبناء محلياً
```bash
npm install
npm run dev
```

للبناء المحلي لمسار فرعي محدد:
```bash
VITE_BASE_PATH=/اسم-المستودع/ npm run build
```
