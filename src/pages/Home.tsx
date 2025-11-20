import {
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonPage,
  IonProgressBar,
  IonTitle,
  IonToolbar,
  useIonToast,
} from '@ionic/react';
import { Browser } from '@capacitor/browser';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { resourceService, type ResourceState, type DownloadProgress } from '../services/resourceService';
import './Home.css';

const Home: React.FC = () => {
  const [state, setState] = useState<ResourceState>(resourceService.getState());
  const [progress, setProgress] = useState<DownloadProgress | null>(resourceService.getProgress());
  const [configOpen, setConfigOpen] = useState(false);
  const [pendingUrl, setPendingUrl] = useState(state.resourceUrl);
  const [pendingBranch, setPendingBranch] = useState(state.branch);
  const [launchPending, setLaunchPending] = useState(false);
  const [presentToast] = useIonToast();

  useEffect(() => {
    resourceService
      .init()
      .catch((err) => {
        presentToast({
          message: `初始化资源服务失败: ${err instanceof Error ? err.message : String(err)}`,
          duration: 4000,
          color: 'danger',
        });
      });
    const offState = resourceService.onState((next) => {
      setState(next);
    });
    const offProgress = resourceService.onProgress((value) => {
      setProgress(value);
    });
    const offError = resourceService.onError((message) => {
      presentToast({ message, duration: 3000, color: 'danger' });
      setLaunchPending(false);
    });
    return () => {
      offState();
      offProgress();
      offError();
    };
  }, [presentToast]);

  const openGameInterface = useCallback(
    (port: number) => {
      const url = `http://127.0.0.1:${port}/index.html`;
      Browser.open({ url }).catch((err: unknown) => {
        presentToast({
          message: `无法打开游戏界面: ${err instanceof Error ? err.message : String(err)}`,
          duration: 3000,
          color: 'danger',
        });
      });
    },
    [presentToast],
  );

  useEffect(() => {
    if (launchPending && state.webServerPort) {
      openGameInterface(state.webServerPort);
      setLaunchPending(false);
    }
  }, [launchPending, state.webServerPort, openGameInterface]);

  useEffect(() => {
    setPendingUrl(state.resourceUrl);
    setPendingBranch(state.branch);
  }, [configOpen, state.resourceUrl, state.branch]);

  const downloadButtonLabel = useMemo(() => (state.hasResources ? '重新下载 / 更新' : '下载资源'), [state.hasResources]);

  const handleDownload = useCallback(() => {
    resourceService.downloadResources();
  }, []);

  const handleStartServer = useCallback(() => {
    resourceService.startServer();
  }, []);

  const handleStopServer = useCallback(() => {
    resourceService.stopServer();
  }, []);

  const handleLaunchWeb = useCallback(() => {
    if (!state.hasResources) {
      presentToast({ message: '请先下载资源', duration: 2500, color: 'warning' });
      return;
    }
    resourceService.startWeb();
    setLaunchPending(true);
  }, [presentToast, state.hasResources]);

  const handleConfigSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedUrl = pendingUrl.trim();
      const trimmedBranch = pendingBranch.trim() || 'main';
      if (!trimmedUrl) {
        presentToast({ message: '资源地址不能为空', duration: 2500, color: 'warning' });
        return;
      }
      resourceService
        .setResourceUrl(trimmedUrl, trimmedBranch)
        .then(() => {
          presentToast({ message: '资源地址已更新', duration: 2000, color: 'success' });
          setConfigOpen(false);
        })
        .catch((err) => {
          presentToast({
            message: `保存资源地址失败: ${err instanceof Error ? err.message : String(err)}`,
            duration: 3000,
            color: 'danger',
          });
        });
    },
    [pendingBranch, pendingUrl, presentToast],
  );

  const handleStopWeb = useCallback(() => {
    resourceService.stopWeb();
    setLaunchPending(false);
  }, []);

  const handleOpenExisting = useCallback(() => {
    if (state.webServerPort) {
      openGameInterface(state.webServerPort);
      return;
    }
    handleLaunchWeb();
  }, [handleLaunchWeb, openGameInterface, state.webServerPort]);

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Noname 资源管理</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent fullscreen>
        <IonList lines="full">
          <IonItem>
            <IonLabel>
              <h2>资源地址</h2>
              <p>{state.resourceUrl}</p>
            </IonLabel>
            <IonButton slot="end" onClick={() => setConfigOpen(true)}>
              配置
            </IonButton>
          </IonItem>
          <IonItem>
            <IonLabel>
              <h2>跟踪分支</h2>
              <p>{state.branch}</p>
            </IonLabel>
          </IonItem>
          <IonItem>
            <IonLabel>
              <h2>当前版本</h2>
              <p>{state.version ?? '未下载'}</p>
            </IonLabel>
            <IonButton slot="end" onClick={handleDownload} color="primary">
              {downloadButtonLabel}
            </IonButton>
          </IonItem>
          {progress && (
            <IonItem>
              <IonLabel>
                <h2>下载进度</h2>
                <p>
                  {progress.total
                    ? `${((progress.downloaded / progress.total) * 100).toFixed(1)}%`
                    : `${(progress.downloaded / 1024 / 1024).toFixed(2)} MB`}
                </p>
              </IonLabel>
            </IonItem>
          )}
          {progress && (
            <IonProgressBar
              type={progress.total ? 'determinate' : 'indeterminate'}
              value={progress.total ? progress.downloaded / progress.total : undefined}
            />
          )}
          <IonItem>
            <IonLabel>
              <h2>WebSocket 服务</h2>
              <p>{state.serverRunning ? '运行中 (端口 8080)' : '已停止'}</p>
            </IonLabel>
            {state.serverRunning ? (
              <IonButton slot="end" color="danger" onClick={handleStopServer}>
                停止
              </IonButton>
            ) : (
              <IonButton slot="end" onClick={handleStartServer} disabled={!state.hasResources}>
                启动
              </IonButton>
            )}
          </IonItem>
          <IonItem>
            <IonLabel>
              <h2>本地 Web 界面</h2>
              <p>
                {state.webServerPort
                  ? `服务端口 ${state.webServerPort}`
                  : launchPending
                    ? '正在启动...'
                    : '未开启'}
              </p>
            </IonLabel>
            {launchPending ? (
              <IonButton slot="end" color="medium" onClick={handleStopWeb}>
                取消
              </IonButton>
            ) : state.webServerPort ? (
              <>
                <IonButton slot="end" onClick={handleOpenExisting}>
                  打开界面
                </IonButton>
                <IonButton slot="end" color="danger" onClick={handleStopWeb}>
                  关闭
                </IonButton>
              </>
            ) : (
              <IonButton slot="end" onClick={handleLaunchWeb} disabled={!state.hasResources}>
                启动并打开
              </IonButton>
            )}
          </IonItem>
        </IonList>
        <IonNote className="home-note">
          下载的资源会存储在本地应用沙箱中，更新时会自动覆盖旧版本。
        </IonNote>

        <IonModal isOpen={configOpen} onDidDismiss={() => setConfigOpen(false)}>
          <form className="resource-config" onSubmit={handleConfigSubmit}>
            <IonHeader>
              <IonToolbar>
                <IonTitle>配置资源源</IonTitle>
              </IonToolbar>
            </IonHeader>
            <IonContent className="ion-padding">
              <IonItem>
                <IonLabel position="stacked">资源地址</IonLabel>
                <IonInput
                  value={pendingUrl}
                  onIonChange={(event) => setPendingUrl(event.detail.value ?? '')}
                  placeholder="例如 https://github.com/libnoname/noname.git"
                  required
                />
              </IonItem>
              <IonItem>
                <IonLabel position="stacked">分支</IonLabel>
                <IonInput
                  value={pendingBranch}
                  onIonChange={(event) => setPendingBranch(event.detail.value ?? '')}
                  placeholder="默认 main"
                />
              </IonItem>
              <div className="resource-config__actions">
                <IonButton type="submit">保存</IonButton>
                <IonButton fill="clear" onClick={() => setConfigOpen(false)}>
                  取消
                </IonButton>
              </div>
            </IonContent>
          </form>
        </IonModal>
      </IonContent>
    </IonPage>
  );
};

export default Home;
