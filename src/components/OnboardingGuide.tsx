interface Props {
  canDemo: boolean;
  canManage: boolean;
  demoBusy: boolean;
  onStartDemo: () => void;
  onAddCamera: () => void;
  onConfigureNotify: () => void;
}

/**
 * 首屏空状态引导：新用户没有点位时，用「看演示 → 接摄像头 → 配通知」三步，
 * 直接给出可点动作，避免「导入了却看不到告警」的困惑。
 */
export default function OnboardingGuide({
  canDemo,
  canManage,
  demoBusy,
  onStartDemo,
  onAddCamera,
  onConfigureNotify,
}: Props) {
  return (
    <div className="onboarding">
      <div className="onboarding-head">
        <strong>欢迎使用火情视频识别监控平台</strong>
        <span>
          三步即可跑通：先看一次演示确认全链路，再接入真实摄像头，最后配置告警通知。
        </span>
      </div>
      <div className="onboarding-steps">
        <div className="onboarding-step">
          <span className="onboarding-step-no">1</span>
          <h4>看演示，跑通全链路</h4>
          <p>
            无需任何硬件：用合成火焰直播流自动产生火焰告警，覆盖「播放 → 识别 →
            抓拍/短视频 → 推送 → 统计」完整闭环。
          </p>
          {canDemo ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={demoBusy}
              onClick={onStartDemo}
            >
              {demoBusy ? '启动中…' : '启动演示'}
            </button>
          ) : (
            <span className="onboarding-note">
              演示模式需管理员在「系统管理 → 点位与视频流」中启动
            </span>
          )}
        </div>

        <div className="onboarding-step">
          <span className="onboarding-step-no">2</span>
          <h4>接摄像头，接入真实画面</h4>
          <p>
            添加现场 NVR 的 RTSP 地址，或用 ONVIF 自动发现、品牌设备批量导入；配置后所有账号均可远程查看。
          </p>
          {canManage ? (
            <button type="button" className="btn btn-sm" onClick={onAddCamera}>
              添加点位
            </button>
          ) : (
            <span className="onboarding-note">需管理员配置点位</span>
          )}
        </div>

        <div className="onboarding-step">
          <span className="onboarding-step-no">3</span>
          <h4>配通知，告警不漏接</h4>
          <p>
            把告警推送到企业微信、钉钉或 Webhook，支持 HMAC-SHA256 签名与连续失败自动停用。
          </p>
          {canManage ? (
            <button type="button" className="btn btn-sm" onClick={onConfigureNotify}>
              配置通知
            </button>
          ) : (
            <span className="onboarding-note">需管理员配置通知</span>
          )}
        </div>
      </div>
    </div>
  );
}
