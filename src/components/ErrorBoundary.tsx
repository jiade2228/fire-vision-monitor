import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 全局错误边界。
 *
 * 没有它时，任意**渲染期**异常（后端返回结构变化、枚举扩展、历史脏数据）
 * 都会让 React 卸载整棵树 → 整页白屏，只能靠 F5 恢复，且没有任何提示。
 * 这里把崩溃降级为可读的说明 + 「重新加载」按钮，并保留错误堆栈便于排查。
 *
 * 注意：只兜住渲染期错误；事件回调与异步任务的异常由各自的 try/catch 处理。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] 渲染异常已捕获', error, info.componentStack);
  }

  private readonly handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-fatal" role="alert">
        <h1 className="app-fatal__title">界面出现异常</h1>
        <p className="app-fatal__desc">
          页面渲染时发生错误，为避免循环崩溃已停止自动刷新。请点击下方按钮重新加载；
          若问题持续，请把下面的错误信息提供给运维。
        </p>
        <pre className="app-fatal__detail">{error.message || String(error)}</pre>
        <button type="button" className="btn app-fatal__action" onClick={this.handleReload}>
          重新加载
        </button>
      </div>
    );
  }
}
