import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader } from '@/components/ui/loader';
import SyntaxHighlighter, { oneDark, oneLight } from '../SyntaxHighlighter';
import Markdown from '../Markdown';
import ImageLightbox from '../ImageLightbox';
import DocumentErrorBoundary from '../viewers/DocumentErrorBoundary';
import { stripLineNumbers } from '../toolDisplayConfig';
import type { FileLocation } from '../../utils/fileLocation';
import type { ContextPayload, EditorTextSelectData } from './types';
import { EXT_TO_LANG, getFileExtension } from './fileMeta';
import { imageMime, type FileBody } from './fileBody';
import { FileErrorDisplay, type FileError } from './fileErrors';
import { DocumentErrorFallback, DocumentLoadingFallback } from './fallbacks';
import type { useFileFocus } from './useFileFocus';

const PdfViewer = React.lazy(() => import('../viewers/PdfViewer'));
const CsvViewer = React.lazy(() => import('../viewers/CsvViewer'));
const HtmlViewer = React.lazy(() => import('../viewers/HtmlViewer'));
const CodeEditor = React.lazy(() => import('../viewers/CodeEditor'));

/**
 * The spreadsheet viewer is growing a cell cursor and a formula bar in a
 * parallel change; these are the props it is agreed to take, all optional, so
 * the panel can wire the ones it owns before that lands.
 */
interface ExcelViewerProps {
  data: ArrayBuffer;
  filePath?: string;
  onAddContext?: (ctx: ContextPayload) => void;
  focusCell?: string | null;
}
const ExcelViewer = React.lazy(() => import('../viewers/ExcelViewer')) as React.ComponentType<ExcelViewerProps>;

export interface FileViewerProps {
  path: string;
  body: FileBody | null;
  loading: boolean;
  error: FileError | null;
  onRetry: () => void;
  /** Offered where the viewer failed; a toast reports its own failure. */
  onDownloadInFallback?: () => void;
  onDownload?: () => void;

  workspaceId: string;
  focus: ReturnType<typeof useFileFocus>;
  onPageCount: (pages: number) => void;

  isEditing: boolean;
  editContent: string | null;
  originalContent: string | null;
  showDiff: boolean;
  editorRef: React.RefObject<unknown>;
  onEditorChange: (value: string) => void;
  onUndoRedoChange: (state: { canUndo: boolean; canRedo: boolean }) => void;
  onEditorTextSelect: (data: EditorTextSelectData | null) => void;

  onAddContext: ((ctx: ContextPayload) => void) | null;
  onContentMouseUp: () => void;
  onViewerLink: (path: string, workspaceId?: string, location?: FileLocation, rooted?: boolean) => void;
  onAnchorLink: (fragment: string) => void;
  servedUrl?: string;
  onCopyShareLink?: ((filePath: string) => void) | null;
}

/** The open file, rendered by whichever viewer its bytes belong to. */
export function FileViewer(props: FileViewerProps): React.ReactElement {
  const { path, body, loading, error, isEditing } = props;
  const { t } = useTranslation();
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const ext = getFileExtension(path);
  const fileName = path.split('/').pop() || path;

  // An image is cached as bytes, not as a blob URL: a URL minted into the
  // query cache has no owner left to revoke it, and the leak is the whole
  // image. Minted here instead, it dies with the view that showed it.
  const imageUrl = useMemo(
    () => (body?.mime === 'image' && body.buffer
      ? URL.createObjectURL(new Blob([body.buffer], { type: imageMime(path) }))
      : null),
    [body?.mime, body?.buffer, path],
  );
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  const editor = (
    <div className="file-panel-editor-container">
      <Suspense fallback={<DocumentLoadingFallback />}>
        <CodeEditor
          value={props.editContent ?? undefined}
          onChange={props.onEditorChange}
          fileName={path}
          diffMode={props.showDiff}
          originalValue={props.originalContent ?? undefined}
          editorRef={props.editorRef as React.RefObject<never>}
          onUndoRedoChange={props.onUndoRedoChange}
          onTextSelect={props.onAddContext ? props.onEditorTextSelect : undefined}
        />
      </Suspense>
    </div>
  );

  if (loading) {
    return (
      <div className="p-4">
        <div className="flex items-center justify-center py-12">
          <Loader size={20} className="text-[color:var(--color-text-tertiary)]" />
        </div>
      </div>
    );
  }

  if (error) {
    return <FileErrorDisplay error={error} onRetry={props.onRetry} onDownload={props.onDownload} />;
  }

  if (body?.mime === 'pdf') {
    return (
      <Suspense fallback={<DocumentLoadingFallback />}>
        <DocumentErrorBoundary fallback={<DocumentErrorFallback onDownload={props.onDownloadInFallback} />}>
          <PdfViewer data={body.buffer!} focusPage={props.focus.focusPage} focusSeq={props.focus.seq} onPageCount={props.onPageCount} />
        </DocumentErrorBoundary>
      </Suspense>
    );
  }

  if (body?.mime === 'excel') {
    return (
      <Suspense fallback={<DocumentLoadingFallback />}>
        <DocumentErrorBoundary fallback={<DocumentErrorFallback onDownload={props.onDownloadInFallback} />}>
          <ExcelViewer
            data={body.buffer!}
            filePath={path}
            onAddContext={props.onAddContext ?? undefined}
            focusCell={props.focus.focusCell}
          />
        </DocumentErrorBoundary>
      </Suspense>
    );
  }

  if (ext === 'csv') {
    return isEditing ? editor : (
      <Suspense fallback={<DocumentLoadingFallback />}>
        <DocumentErrorBoundary fallback={<DocumentErrorFallback onDownload={props.onDownloadInFallback} />}>
          <CsvViewer content={body?.content ?? ''} />
        </DocumentErrorBoundary>
      </Suspense>
    );
  }

  if (ext === 'html' || ext === 'htm') {
    return (
      <Suspense fallback={<DocumentLoadingFallback />}>
        <DocumentErrorBoundary fallback={<DocumentErrorFallback onDownload={props.onDownloadInFallback} />}>
          <HtmlViewer
            content={body?.content ?? ''}
            fileName={fileName}
            workspaceId={props.workspaceId}
            filePath={path}
            servedUrlOverride={props.servedUrl}
            anchor={props.focus.htmlAnchor}
            anchorSeq={props.focus.seq}
            onCopyShareLink={props.onCopyShareLink ?? undefined}
            onTriggerDownload={props.onDownloadInFallback}
          />
        </DocumentErrorBoundary>
      </Suspense>
    );
  }

  if (isEditing) return editor;

  return (
    <div className="p-4" onMouseUp={props.onContentMouseUp}>
      {body?.mime === 'image' && imageUrl ? (
        <>
          <img src={imageUrl} alt={fileName} className="max-w-full rounded cursor-pointer" onClick={() => setLightboxOpen(true)} />
          <ImageLightbox src={imageUrl} alt={fileName} open={lightboxOpen} onClose={() => setLightboxOpen(false)} />
        </>
      ) : path.startsWith('/large_tool_results/') ? (
        <div className="markdown-print-content">
          <Markdown variant="panel" content={stripLineNumbers(body?.content ?? null) ?? ''} className="text-sm" />
        </div>
      ) : body?.mime?.includes('markdown') || ext === 'md' ? (
        <div className="markdown-print-content">
          <Markdown
            variant="panel"
            content={body?.content ?? ''}
            className="text-sm"
            onOpenFile={props.onViewerLink}
            onAnchorLink={props.onAnchorLink}
          />
        </div>
      ) : body?.content != null ? (
        <SyntaxHighlighter
          language={EXT_TO_LANG[ext] || 'text'}
          style={typeof window !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? oneLight : oneDark}
          customStyle={{ margin: 0, padding: 0, backgroundColor: 'transparent', fontSize: '0.75rem', lineHeight: '1.6' }}
          codeTagProps={{ style: { backgroundColor: 'transparent' } }}
          showLineNumbers
          lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1em', color: 'var(--color-text-tertiary)', userSelect: 'none', fontSize: '0.6875rem', opacity: 0.5 }}
          wrapLines
          lineProps={(lineNumber: number) => {
            const range = props.focus.lineRange;
            const focused = !!range && lineNumber >= range[0] && lineNumber <= range[1];
            return { 'data-line': lineNumber, ...(focused ? { className: 'file-focus-line' } : {}) } as React.HTMLProps<HTMLElement>;
          }}
          wrapLongLines
        >
          {body.content}
        </SyntaxHighlighter>
      ) : (
        <p className="text-sm" style={{ color: 'var(--color-text-tertiary)' }}>{t('filePanel.emptyFile')}</p>
      )}
    </div>
  );
}
