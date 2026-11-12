import type { FileDropEvent } from 'file-drop-element';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import type { SnackOptions } from 'shared/custom-els/snack-bar';

import { h, Component } from 'preact';

import { linkRef } from 'shared/prerendered-app/util';
import * as style from './style.css';
import 'add-css:./style.css';
import 'file-drop-element';
import 'shared/custom-els/snack-bar';
import Intro from 'shared/prerendered-app/Intro';
import 'shared/custom-els/loading-spinner';

const ROUTE_EDITOR = '/editor';

const compressPromise = import('client/lazy-app/Compress');
const batchPromise = import('client/lazy-app/Batch');
const swBridgePromise = import('client/lazy-app/sw-bridge');

function back() {
  window.history.back();
}

interface Props {}

interface State {
  awaitingShareTarget: boolean;
  file?: File;
  isEditorOpen: Boolean;
  isBatchOpen: boolean;
  batchFiles: File[];
  Compress?: typeof import('client/lazy-app/Compress').default;
  Batch?: typeof import('client/lazy-app/Batch').default;
}

export default class App extends Component<Props, State> {
  state: State = {
    awaitingShareTarget: new URL(location.href).searchParams.has(
      'share-target',
    ),
    isEditorOpen: false,
    isBatchOpen: false,
    batchFiles: [],
    file: undefined,
    Compress: undefined,
    Batch: undefined,
  };

  snackbar?: SnackBarElement;
  private batch?: import('client/lazy-app/Batch').default;

  constructor() {
    super();

    compressPromise
      .then((module) => {
        this.setState({ Compress: module.default });
      })
      .catch(() => {
        this.showSnack('应用加载失败');
      });

    batchPromise
      .then((module) => {
        this.setState({ Batch: module.default });
      })
      .catch(() => {
        this.showSnack('批量压缩加载失败');
      });

    swBridgePromise.then(async ({ offliner, getSharedImage }) => {
      offliner(this.showSnack);
      if (!this.state.awaitingShareTarget) return;
      const file = await getSharedImage();
      // Remove the ?share-target from the URL
      history.replaceState('', '', '/');
      this.openEditor();
      this.setState({ file, awaitingShareTarget: false, isBatchOpen: false });
    });

    // Since iOS 10, Apple tries to prevent disabling pinch-zoom. This is great in theory, but
    // really breaks things on Squoosh, as you can easily end up zooming the UI when you mean to
    // zoom the image. Once you've done this, it's really difficult to undo. Anyway, this seems to
    // prevent it.
    document.body.addEventListener('gesturestart', (event: any) => {
      event.preventDefault();
    });

    window.addEventListener('popstate', this.onPopState);
  }

  private onFileDrop = ({ files }: FileDropEvent) => {
    if (!files || files.length === 0) return;
    this.onFiles(Array.from(files));
  };

  private onIntroPickFile = (file: File) => {
    this.onFiles([file]);
  };

  private onFiles = (files: File[]) => {
    if (files.length === 0) return;
    if (this.state.isEditorOpen && this.state.isBatchOpen) {
      if (this.batch) {
        this.batch.addFiles(files);
      } else {
        this.setState((state) => ({
          batchFiles: [...state.batchFiles, ...files],
        }));
      }
      return;
    }
    if (files.length > 1) {
      this.openBatch(files);
      return;
    }
    this.openEditor();
    this.setState({ file: files[0], isBatchOpen: false, batchFiles: [] });
  };

  private openBatch = (files: File[]) => {
    this.openEditor();
    this.setState({ isBatchOpen: true, batchFiles: files, file: undefined });
  };

  private onBatchOpen = () => {
    this.openBatch([]);
  };

  private onBatchFilesChange = (files: File[]) => {
    this.setState({ batchFiles: files });
  };

  private showSnack = (
    message: string,
    options: SnackOptions = {},
  ): Promise<string> => {
    if (!this.snackbar) throw Error('缺少提示条');
    return this.snackbar.showSnackbar(message, options);
  };

  private onPopState = () => {
    this.setState({ isEditorOpen: location.pathname === ROUTE_EDITOR });
  };

  private openEditor = () => {
    if (this.state.isEditorOpen) return;
    // Change path, but preserve query string.
    const editorURL = new URL(location.href);
    editorURL.pathname = ROUTE_EDITOR;
    history.pushState(null, '', editorURL.href);
    this.setState({ isEditorOpen: true });
  };

  render(
    {}: Props,
    {
      file,
      isEditorOpen,
      isBatchOpen,
      batchFiles,
      Compress,
      Batch,
      awaitingShareTarget,
    }: State,
  ) {
    const showSpinner =
      awaitingShareTarget ||
      (isEditorOpen && !(isBatchOpen ? Batch : Compress));

    return (
      <div class={style.app}>
        <file-drop multiple onfiledrop={this.onFileDrop} class={style.drop}>
          {showSpinner ? (
            <loading-spinner class={style.appLoader} />
          ) : isEditorOpen ? (
            isBatchOpen ? (
              Batch && (
                <Batch
                  ref={linkRef(this, 'batch')}
                  files={batchFiles}
                  onFilesChange={this.onBatchFilesChange}
                  showSnack={this.showSnack}
                  onBack={back}
                />
              )
            ) : (
              Compress && (
                <Compress
                  file={file!}
                  showSnack={this.showSnack}
                  onBack={back}
                />
              )
            )
          ) : (
            <Intro
              onFile={this.onIntroPickFile}
              onFiles={this.onFiles}
              onBatch={this.onBatchOpen}
              showSnack={this.showSnack}
            />
          )}
          <snack-bar ref={linkRef(this, 'snackbar')} />
        </file-drop>
      </div>
    );
  }
}
