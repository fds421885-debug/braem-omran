import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    message: '',
  };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message || 'حدث خطأ غير متوقع.',
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught ErrorBoundary error:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, message: '' });
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#FDF6EE] flex items-center justify-center p-4" dir="rtl">
          <div className="w-full max-w-md bg-white border-2 border-[#EADBC8] rounded-3xl p-6 sm:p-8 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-[#D95338]/10 text-[#D95338] flex items-center justify-center">
              <AlertTriangle className="w-8 h-8" />
            </div>
            <h1 className="font-display text-2xl font-extrabold text-[#4A220D] mb-2">
              تعذّر تحميل هذه الخطوة
            </h1>
            <p className="text-sm text-[#7D4E35] mb-6 leading-relaxed">
              واجه التطبيق مشكلة مؤقتة أثناء الاتصال بالبيانات. يمكنك إعادة المحاولة الآن.
            </p>
            <button
              type="button"
              onClick={this.handleReset}
              className="duo-btn-orange w-full min-h-[48px] px-6 py-3 rounded-2xl font-display font-bold text-base inline-flex items-center justify-center gap-2 cursor-pointer"
            >
              <RotateCcw className="w-5 h-5" />
              <span>إعادة تحميل المنصة</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
