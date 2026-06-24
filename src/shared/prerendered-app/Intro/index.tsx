import { h, Component } from 'preact';

import { linkRef } from 'shared/prerendered-app/util';
import githubLogo from 'url:./imgs/github-logo.svg';
import smallSectionAsset from 'url:./imgs/info-content/small.svg';
import simpleSectionAsset from 'url:./imgs/info-content/simple.svg';
import secureSectionAsset from 'url:./imgs/info-content/secure.svg';
import logoWithText from 'data-url-text:./imgs/logo-with-text.svg';
import * as style from './style.css';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import 'shared/custom-els/snack-bar';
import { startBlobs } from './blob-anim/meta';
import SlideOnScroll from './SlideOnScroll';

const blobAnimImport =
  !__PRERENDER__ && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? undefined
    : import('./blob-anim');
const installButtonSource = 'introInstallButton-Purple';
const supportsClipboardAPI =
  !__PRERENDER__ && navigator.clipboard && navigator.clipboard.read;

async function getImageClipboardItem(
  items: ClipboardItem[],
): Promise<undefined | Blob> {
  for (const item of items) {
    const type = item.types.find((type) => type.startsWith('image/'));
    if (type) return item.getType(type);
  }
}

interface Props {
  onFile?: (file: File) => void;
  showSnack?: SnackBarElement['showSnackbar'];
}
interface State {
  beforeInstallEvent?: BeforeInstallPromptEvent;
  showBlobSVG: boolean;
}

export default class Intro extends Component<Props, State> {
  state: State = {
    showBlobSVG: true,
  };
  private fileInput?: HTMLInputElement;
  private blobCanvas?: HTMLCanvasElement;
  private installingViaButton = false;

  componentDidMount() {
    // Listen for beforeinstallprompt events, indicating Squoosh is installable.
    window.addEventListener(
      'beforeinstallprompt',
      this.onBeforeInstallPromptEvent,
    );

    // Listen for the appinstalled event, indicating Squoosh has been installed.
    window.addEventListener('appinstalled', this.onAppInstalled);

    if (blobAnimImport) {
      blobAnimImport.then((module) => {
        this.setState(
          {
            showBlobSVG: false,
          },
          () => module.startBlobAnim(this.blobCanvas!),
        );
      });
    }
  }

  componentWillUnmount() {
    window.removeEventListener(
      'beforeinstallprompt',
      this.onBeforeInstallPromptEvent,
    );
    window.removeEventListener('appinstalled', this.onAppInstalled);
  }

  private onFileChange = (event: Event): void => {
    const fileInput = event.target as HTMLInputElement;
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    this.fileInput!.value = '';
    this.props.onFile!(file);
  };

  private onOpenClick = () => {
    this.fileInput!.click();
  };

  private onBeforeInstallPromptEvent = (event: BeforeInstallPromptEvent) => {
    // Don't show the mini-infobar on mobile
    event.preventDefault();

    // Save the beforeinstallprompt event so it can be called later.
    this.setState({ beforeInstallEvent: event });

    // Log the event.
    const gaEventInfo = {
      eventCategory: 'pwa-install',
      eventAction: 'promo-shown',
      nonInteraction: true,
    };
    ga('send', 'event', gaEventInfo);
  };

  private onInstallClick = async (event: Event) => {
    // Get the deferred beforeinstallprompt event
    const beforeInstallEvent = this.state.beforeInstallEvent;
    // If there's no deferred prompt, bail.
    if (!beforeInstallEvent) return;

    this.installingViaButton = true;

    // Show the browser install prompt
    beforeInstallEvent.prompt();

    // Wait for the user to accept or dismiss the install prompt
    const { outcome } = await beforeInstallEvent.userChoice;
    // Send the analytics data
    const gaEventInfo = {
      eventCategory: 'pwa-install',
      eventAction: 'promo-clicked',
      eventLabel: installButtonSource,
      eventValue: outcome === 'accepted' ? 1 : 0,
    };
    ga('send', 'event', gaEventInfo);

    // If the prompt was dismissed, we aren't going to install via the button.
    if (outcome === 'dismissed') {
      this.installingViaButton = false;
    }
  };

  private onAppInstalled = () => {
    // We don't need the install button, if it's shown
    this.setState({ beforeInstallEvent: undefined });

    // Don't log analytics if page is not visible
    if (document.hidden) return;

    // Try to get the install, if it's not set, use 'browser'
    const source = this.installingViaButton ? installButtonSource : 'browser';
    ga('send', 'event', 'pwa-install', 'installed', source);

    // Clear the install method property
    this.installingViaButton = false;
  };

  private onPasteClick = async () => {
    let clipboardItems: ClipboardItem[];

    try {
      clipboardItems = await navigator.clipboard.read();
    } catch (err) {
      this.props.showSnack!(`无权访问剪贴板`);
      return;
    }

    const blob = await getImageClipboardItem(clipboardItems);

    if (!blob) {
      this.props.showSnack!(`剪贴板中未找到图片`);
      return;
    }

    this.props.onFile!(new File([blob], 'image.unknown'));
  };

  render(
    {}: Props,
    { beforeInstallEvent, showBlobSVG }: State,
  ) {
    return (
      <div class={style.intro}>
        <input
          class={style.hide}
          ref={linkRef(this, 'fileInput')}
          type="file"
          onChange={this.onFileChange}
        />
        <div class={style.main}>
          {!__PRERENDER__ && (
            <canvas
              ref={linkRef(this, 'blobCanvas')}
              class={style.blobCanvas}
            />
          )}
          <h1 class={style.logoContainer}>
            <img
              class={style.logo}
              src={logoWithText}
              alt="Squoosh"
              width="539"
              height="162"
            />
          </h1>
          <div class={style.loadImg}>
            {showBlobSVG && (
              <svg
                class={style.blobSvg}
                viewBox="-1.25 -1.25 2.5 2.5"
                preserveAspectRatio="xMidYMid slice"
              >
                {startBlobs.map((points) => (
                  <path
                    d={points
                      .map((point, i) => {
                        const nextI = i === points.length - 1 ? 0 : i + 1;
                        let d = '';
                        if (i === 0) {
                          d += `M${point[2]} ${point[3]}`;
                        }
                        return (
                          d +
                          `C${point[4]} ${point[5]} ${points[nextI][0]} ${points[nextI][1]} ${points[nextI][2]} ${points[nextI][3]}`
                        );
                      })
                      .join('')}
                  />
                ))}
              </svg>
            )}
            <div
              class={style.loadImgContent}
              style={{ visibility: __PRERENDER__ ? 'hidden' : '' }}
            >
              <button class={style.loadBtn} onClick={this.onOpenClick}>
                <svg viewBox="0 0 24 24" class={style.loadIcon}>
                  <path d="M19 7v3h-2V7h-3V5h3V2h2v3h3v2h-3zm-3 4V8h-3V5H5a2 2 0 00-2 2v12c0 1.1.9 2 2 2h12a2 2 0 002-2v-8h-3zM5 19l3-4 2 3 3-4 4 5H5z" />
                </svg>
              </button>
              <div>
                <span class={style.dropText}>拖放 </span>或{' '}
                {supportsClipboardAPI ? (
                  <button class={style.pasteBtn} onClick={this.onPasteClick}>
                    粘贴
                  </button>
                ) : (
                  '粘贴'
                )}
              </div>
            </div>
          </div>
        </div>

        <div class={style.bottomWave}>
          <svg viewBox="0 0 1920 79" class={style.topWave}>
            <path
              d="M0 59l64-11c64-11 192-34 320-43s256-5 384 4 256 23 384 34 256 21 384 14 256-30 320-41l64-11v94H0z"
              class={style.infoWave}
            />
          </svg>
        </div>

        <section class={style.info}>
          <div class={style.infoContainer}>
            <SlideOnScroll>
              <div class={style.infoContent}>
                <div class={style.infoTextWrapper}>
                  <h2 class={style.infoTitle}>更小</h2>
                  <p class={style.infoCaption}>
                    图片越小，加载越快。Squoosh 可以在保持高画质的同时减小文件体积。
                  </p>
                </div>
                <div class={style.infoImgWrapper}>
                  <img
                    class={style.infoImg}
                    src={smallSectionAsset}
                    alt="一张 1.4 兆字节大图缩小为 80 千字节小图的剪影"
                    width="536"
                    height="522"
                  />
                </div>
              </div>
            </SlideOnScroll>
          </div>
        </section>

        <section class={style.info}>
          <div class={style.infoContainer}>
            <SlideOnScroll>
              <div class={style.infoContent}>
                <div class={style.infoTextWrapper}>
                  <h2 class={style.infoTitle}>简单</h2>
                  <p class={style.infoCaption}>
                    打开图片，对比差异，然后立即保存。需要更小的文件时，也可以调整参数。
                  </p>
                </div>
                <div class={style.infoImgWrapper}>
                  <img
                    class={style.infoImg}
                    src={simpleSectionAsset}
                    alt="展示多种选项的缩小图片网格"
                    width="538"
                    height="384"
                  />
                </div>
              </div>
            </SlideOnScroll>
          </div>
        </section>

        <section class={style.info}>
          <div class={style.infoContainer}>
            <SlideOnScroll>
              <div class={style.infoContent}>
                <div class={style.infoTextWrapper}>
                  <h2 class={style.infoTitle}>安全</h2>
                  <p class={style.infoCaption}>
                    担心隐私？所有处理都在本地完成，图片不会离开你的设备。
                  </p>
                </div>
                <div class={style.infoImgWrapper}>
                  <img
                    class={style.infoImg}
                    src={secureSectionAsset}
                    alt="带有禁止符号的云朵剪影"
                    width="498"
                    height="333"
                  />
                </div>
              </div>
            </SlideOnScroll>
          </div>
        </section>

        <footer class={style.footer}>
          <div class={style.footerContainer}>
            <svg viewBox="0 0 1920 79" class={style.topWave}>
              <path
                d="M0 59l64-11c64-11 192-34 320-43s256-5 384 4 256 23 384 34 256 21 384 14 256-30 320-41l64-11v94H0z"
                class={style.footerWave}
              />
            </svg>
            <div class={style.footerPadding}>
              <footer class={style.footerItems}>
                <a
                  class={style.footerLink}
                  href="https://github.com/GoogleChromeLabs/squoosh/blob/dev/README.md#privacy"
                >
                  隐私
                </a>
                <a
                  class={style.footerLinkWithLogo}
                  href="https://github.com/GoogleChromeLabs/squoosh"
                >
                  <img src={githubLogo} alt="" width="10" height="10" />
                  GitHub 源码
                </a>
              </footer>
            </div>
          </div>
        </footer>
        {beforeInstallEvent && (
          <button class={style.installBtn} onClick={this.onInstallClick}>
            安装
          </button>
        )}
      </div>
    );
  }
}
