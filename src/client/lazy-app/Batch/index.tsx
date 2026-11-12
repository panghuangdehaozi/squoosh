import { h, Component } from 'preact';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import { linkRef } from 'shared/prerendered-app/util';
import {
  encoderMap,
  EncoderState,
  EncoderType,
  EncoderOptions,
} from '../feature-meta';
import { compressFile, imageErrorMessage } from '../util/image-processing';
import { assertSignal } from '../util';
import WorkerBridge from '../worker-bridge';
import prettyBytes from '../Compress/Results/pretty-bytes';
import { createZip } from './zip';
import * as style from './style.css';
import 'add-css:./style.css';
import 'add-css:../Compress/Options/style.css';

interface Props {
  files: File[];
  onBack(): void;
  onFilesChange(files: File[]): void;
  showSnack: SnackBarElement['showSnackbar'];
}

interface Item {
  id: number;
  source: File;
  status: 'pending' | 'processing' | 'done' | 'error';
  result?: File;
  url?: string;
  error?: string;
  warning?: string;
}

interface State {
  items: Item[];
  encoder: EncoderState;
  supportedTypes: EncoderType[];
  running: boolean;
  packing: boolean;
}

function formatSize(bytes: number): string {
  const size = prettyBytes(bytes);
  return `${size.value} ${size.unit}`;
}

function sizeChange(before: number, after: number): string {
  if (!before) return '—';
  const change = (1 - after / before) * 100;
  return `${change >= 0 ? '减少' : '增大'} ${Math.abs(change).toFixed(1)}%`;
}

const statusLabels = {
  pending: '待压缩',
  processing: '压缩中…',
  done: '已完成',
  error: '失败',
};

export default class Batch extends Component<Props, State> {
  private nextId = 0;
  private worker = new WorkerBridge();
  private controller?: AbortController;
  private zipController?: AbortController;
  private urls = new Set<string>();
  private mounted = false;
  private fileInput?: HTMLInputElement;

  constructor(props: Props) {
    super(props);
    this.state = {
      items: this.makeItems(props.files),
      encoder: {
        type: 'mozJPEG',
        options: { ...encoderMap.mozJPEG.meta.defaultOptions },
      },
      supportedTypes: [],
      running: false,
      packing: false,
    };
  }

  componentDidMount() {
    this.mounted = true;
    Promise.all(
      (Object.keys(encoderMap) as EncoderType[]).map(async (type) => {
        const encoder = encoderMap[type];
        try {
          return !('featureTest' in encoder) || (await encoder.featureTest())
            ? type
            : undefined;
        } catch {
          return undefined;
        }
      }),
    ).then((types) => {
      if (this.mounted) {
        this.setState({
          supportedTypes: types.filter((type): type is EncoderType => !!type),
        });
      }
    });
  }

  componentWillUnmount() {
    this.mounted = false;
    this.controller?.abort();
    this.zipController?.abort();
    this.releaseUrls();
  }

  private makeItems(files: File[]): Item[] {
    return files.map((source) => ({
      id: this.nextId++,
      source,
      status: 'pending',
    }));
  }

  addFiles = (files: File[]) => {
    if (this.controller || this.zipController) {
      this.props.showSnack('请等待处理完成，或先停止压缩再添加图片。');
      return;
    }
    this.setState(
      (state) => ({ items: [...state.items, ...this.makeItems(files)] }),
      this.syncFiles,
    );
  };

  private syncFiles = () => {
    this.props.onFilesChange(this.state.items.map((item) => item.source));
  };

  private onFileChange = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    this.addFiles(Array.from(input.files || []));
    input.value = '';
  };

  private releaseUrls() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  private clear = () => {
    if (this.controller || this.zipController) return;
    this.releaseUrls();
    this.setState({ items: [] }, this.syncFiles);
  };

  private remove = (id: number) => {
    if (this.controller || this.zipController) return;
    const item = this.state.items.find((item) => item.id === id);
    if (item?.url) {
      URL.revokeObjectURL(item.url);
      this.urls.delete(item.url);
    }
    this.setState(
      (state) => ({ items: state.items.filter((item) => item.id !== id) }),
      this.syncFiles,
    );
  };

  private changeEncoder(encoder: EncoderState) {
    if (this.controller || this.zipController) return;
    this.releaseUrls();
    this.setState((state) => ({
      encoder,
      items: state.items.map(({ id, source }) => ({
        id,
        source,
        status: 'pending',
      })),
    }));
  }

  private onTypeChange = (event: Event) => {
    const type = (event.currentTarget as HTMLSelectElement)
      .value as EncoderType;
    this.changeEncoder({
      type,
      options: { ...encoderMap[type].meta.defaultOptions },
    } as EncoderState);
  };

  private onOptionsChange = (options: EncoderOptions) => {
    this.changeEncoder({ ...this.state.encoder, options } as EncoderState);
  };

  private updateItem(id: number, changes: Partial<Item>) {
    if (!this.mounted) return;
    this.setState((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, ...changes } : item,
      ),
    }));
  }

  private start = async () => {
    if (this.controller || this.zipController) return;
    const jobs = this.state.items.filter((item) => item.status !== 'done');
    if (!jobs.length) return;
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const encoder = this.state.encoder;
    this.setState((state) => ({
      running: true,
      items: state.items.map((item) =>
        item.status === 'error'
          ? { ...item, status: 'pending', error: undefined }
          : item,
      ),
    }));

    try {
      // Process one image at a time so decoded pixels are not retained for the whole batch.
      for (const item of jobs) {
        if (signal.aborted) break;
        this.updateItem(item.id, { status: 'processing' });
        try {
          const { file, warning } = await compressFile(
            signal,
            item.source,
            encoder,
            this.worker,
          );
          assertSignal(signal);
          const url = URL.createObjectURL(file);
          this.urls.add(url);
          this.updateItem(item.id, {
            status: 'done',
            result: file,
            url,
            warning,
            error: undefined,
          });
        } catch (error) {
          if (signal.aborted) break;
          this.updateItem(item.id, {
            status: 'error',
            error: imageErrorMessage('压缩失败', error),
          });
        }
      }
    } finally {
      this.controller = undefined;
      if (this.mounted) {
        this.setState((state) => ({
          running: false,
          items: state.items.map((item) =>
            item.status === 'processing'
              ? { ...item, status: 'pending' }
              : item,
          ),
        }));
      }
    }
  };

  private stop = () => {
    this.controller?.abort();
  };

  private downloadZip = async () => {
    if (this.controller || this.zipController) return;
    const files = this.state.items.flatMap((item) =>
      item.result ? [item.result] : [],
    );
    if (!files.length) return;
    const controller = new AbortController();
    this.zipController = controller;
    this.setState({ packing: true });
    try {
      const blob = await createZip(files, controller.signal);
      assertSignal(controller.signal);
      const url = URL.createObjectURL(blob);
      this.urls.add(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'squoosh-images.zip';
      document.body.append(link);
      link.click();
      link.remove();
      // Give the browser time to start reading the archive before releasing it.
      setTimeout(() => {
        URL.revokeObjectURL(url);
        this.urls.delete(url);
      }, 60_000);
    } catch (error) {
      if (!controller.signal.aborted)
        this.props.showSnack(imageErrorMessage('打包失败', error));
    } finally {
      this.zipController = undefined;
      if (this.mounted) this.setState({ packing: false });
    }
  };

  render(
    { onBack }: Props,
    { items, encoder, supportedTypes, running, packing }: State,
  ) {
    const done = items.filter((item) => item.status === 'done');
    const failed = items.filter((item) => item.status === 'error').length;
    const pending = items.length - done.length;
    const before = done.reduce((sum, item) => sum + item.source.size, 0);
    const after = done.reduce((sum, item) => sum + item.result!.size, 0);
    const current = items.find((item) => item.status === 'processing');
    const codec = encoderMap[encoder.type];
    const EncoderOptionsComponent =
      'Options' in codec ? codec.Options : undefined;
    const busy = running || packing;

    return (
      <main class={style.batch}>
        <header class={style.header}>
          <button class={style.back} onClick={onBack} aria-label="返回首页">
            ←
          </button>
          <h1>批量压缩</h1>
          <span class={style.fileCount}>{items.length} 张图片</span>
        </header>
        <div class={style.workspace}>
          <section class={style.queue} aria-label="图片列表">
            <div class={style.toolbar}>
              <input
                ref={linkRef(this, 'fileInput')}
                type="file"
                multiple
                accept="image/*,.avif,.jxl,.wp2,.qoi"
                onChange={this.onFileChange}
                hidden
              />
              <button
                class={style.button}
                disabled={busy}
                onClick={() => this.fileInput!.click()}
              >
                添加图片
              </button>
              <button
                class={style.textButton}
                disabled={busy || !items.length}
                onClick={this.clear}
              >
                清空列表
              </button>
            </div>
            {items.length ? (
              <div class={style.tableScroll}>
                <table class={style.table}>
                  <thead>
                    <tr>
                      <th>图片</th>
                      <th>原始大小</th>
                      <th>压缩后</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td class={style.fileCell}>
                          <span class={style.filename} title={item.source.name}>
                            {item.source.name}
                          </span>
                          {item.warning && (
                            <span class={style.note}>{item.warning}</span>
                          )}
                          {item.error && (
                            <span class={style.error}>{item.error}</span>
                          )}
                        </td>
                        <td>{formatSize(item.source.size)}</td>
                        <td>
                          {item.result ? (
                            <span>
                              {formatSize(item.result.size)}
                              <small class={style.note}>
                                {sizeChange(item.source.size, item.result.size)}
                              </small>
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          <span
                            class={
                              item.status === 'error'
                                ? style.error
                                : item.status === 'done'
                                ? style.success
                                : ''
                            }
                          >
                            {statusLabels[item.status]}
                          </span>
                        </td>
                        <td>
                          <div class={style.rowActions}>
                            {item.url && (
                              <a
                                href={item.url}
                                download={item.result!.name}
                                aria-label={`下载 ${item.result!.name}`}
                              >
                                下载
                              </a>
                            )}
                            <button
                              class={style.textButton}
                              disabled={busy}
                              onClick={() => this.remove(item.id)}
                              aria-label={`移除 ${item.source.name}`}
                            >
                              移除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div class={style.empty}>
                <h2>一次压缩多张图片</h2>
                <p>拖入图片，或点击“添加图片”开始。</p>
              </div>
            )}
            <div class={style.summary} aria-live="polite">
              <span>
                已完成 {done.length} / {items.length}
                {failed ? `，失败 ${failed}` : ''}
              </span>
              {!!done.length && (
                <span>
                  {formatSize(before)} → {formatSize(after)} ·{' '}
                  {sizeChange(before, after)}
                </span>
              )}
            </div>
          </section>
          <aside class={style.settings} aria-label="统一压缩参数">
            <h2>统一压缩参数</h2>
            <fieldset disabled={busy} class={style.fields}>
              <label class={style.formatLabel}>
                输出格式
                <select
                  value={encoder.type}
                  onChange={this.onTypeChange}
                  disabled={!supportedTypes.length}
                >
                  {(supportedTypes.length
                    ? supportedTypes
                    : (['mozJPEG'] as EncoderType[])
                  ).map((type) => (
                    <option key={type} value={type}>
                      {encoderMap[type].meta.label}
                    </option>
                  ))}
                </select>
              </label>
              {EncoderOptionsComponent && (
                <EncoderOptionsComponent
                  key={encoder.type}
                  options={encoder.options as any}
                  onChange={this.onOptionsChange}
                />
              )}
            </fieldset>
            <div class={style.actions}>
              <progress
                value={done.length + failed}
                max={items.length || 1}
                aria-label="批量压缩进度"
              />
              <p class={style.progressText} role="status">
                {packing
                  ? '正在打包…'
                  : current
                  ? `正在压缩：${current.source.name}`
                  : !items.length
                  ? '添加图片后开始压缩'
                  : pending
                  ? `待处理 ${pending} 张图片`
                  : '全部压缩完成'}
              </p>
              {running ? (
                <button class={style.primary} onClick={this.stop}>
                  停止压缩
                </button>
              ) : (
                <button
                  class={style.primary}
                  disabled={packing || !pending || !supportedTypes.length}
                  onClick={this.start}
                >
                  {failed && pending === failed ? '重试失败项' : '开始压缩'}
                </button>
              )}
              <button
                class={style.downloadAll}
                disabled={busy || !done.length}
                onClick={this.downloadZip}
              >
                {packing
                  ? '正在打包…'
                  : `下载 ZIP${done.length ? `（${done.length} 张）` : ''}`}
              </button>
            </div>
          </aside>
        </div>
      </main>
    );
  }
}
