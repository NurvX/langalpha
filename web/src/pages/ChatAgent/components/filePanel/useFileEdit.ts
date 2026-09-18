import { useCallback, useRef, useState } from 'react';
import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { editor } from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/use-toast';

/** Edit-mode state for FilePanel: full-content load, Monaco editor wiring,
 * diff view, save/cancel, and the unsaved-changes guards. The read/write fns
 * are the component's adapter-resolved versions — never direct api imports. */
export function useFileEdit({ workspaceId, selectedFile, fileContent, setFileContent, readFileFullFn, writeFileFn }: {
  workspaceId: string;
  selectedFile: string | null;
  fileContent: string | null;
  setFileContent: Dispatch<SetStateAction<string | null>>;
  readFileFullFn: (workspaceId: string, path: string) => Promise<{ content?: string }>;
  writeFileFn: (workspaceId: string, path: string, content: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState<string | null>(null);
  // Which file is being written, not whether one is: a save outlives the file
  // it belongs to, and nothing outside this hook can clear a plain flag, so a
  // write that hung left Save dead on every file opened after it. The sequence
  // is the same idea one step finer, for two writes to the same file.
  const [savingFile, setSavingFile] = useState<string | null>(null);
  const saveSeqRef = useRef(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const handleUndoRedoChange = useCallback(({ canUndo: u, canRedo: r }: { canUndo: boolean; canRedo: boolean }) => {
    setCanUndo(u);
    setCanRedo(r);
  }, []);

  const isSaving = savingFile !== null && savingFile === selectedFile;
  const hasUnsavedChanges = isEditing && editContent !== null && editContent !== fileContent;
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;

  const handleStartEdit = useCallback(async () => {
    if (!selectedFile || !workspaceId) return;
    setSaveError(null);
    try {
      const data = await readFileFullFn(workspaceId, selectedFile);
      // Another file opened while the full read was in flight.
      if (selectedFileRef.current !== selectedFile) return;
      const fullContent = data.content || '';
      if (fullContent.length > 500 * 1024) {
        setSaveError(t('filePanel.fileTooLarge'));
        return;
      }
      setEditContent(fullContent);
      setOriginalContent(fullContent);
      setFileContent(fullContent);
      setIsEditing(true);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      console.error('[FilePanel] Failed to fetch full file for editing:', err);
      // The read that failed is for a file the panel has already left, so its
      // error would otherwise appear under the name now on screen.
      if (selectedFileRef.current !== selectedFile) return;
      setSaveError(e?.response?.data?.detail || e?.message || t('filePanel.loadEditFailed'));
    }
  }, [selectedFile, workspaceId, readFileFullFn, setFileContent, t]);

  const handleEditorChange = useCallback((value: string) => {
    setEditContent(value);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedFile || !workspaceId || editContent === null) return;
    // The button carries the only other re-entry guard and the key handler
    // below does not read it, so this one belongs where every caller passes.
    if (savingFile === selectedFile) return;
    if (!window.confirm(t('filePanel.confirmSave'))) return;
    const seq = ++saveSeqRef.current;
    setSavingFile(selectedFile);
    setSaveError(null);
    try {
      await writeFileFn(workspaceId, selectedFile, editContent);
      // Another file opened while the write was in flight, the same guard the
      // full read takes above. Without it this file's text lands in the panel
      // under the other one's name, and feeds its line and heading lookup.
      if (selectedFileRef.current !== selectedFile) return;
      setFileContent(editContent);
      setIsEditing(false);
      setEditContent(null);
      setShowDiff(false);
      setOriginalContent(null);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      console.error('[FilePanel] Save failed:', err);
      if (selectedFileRef.current !== selectedFile) {
        // The panel has moved on, so there is no header left to hang an inline
        // error under. Staying silent here is what let a reader answer "discard
        // unsaved changes" believing the save had landed and lose the edit with
        // nothing on screen to say otherwise, so the toast names the file.
        toast({
          description: t('filePanel.saveFailedFile', { name: selectedFile.split('/').pop() }),
          variant: 'destructive',
        });
        return;
      }
      setSaveError(e?.response?.data?.detail || e?.message || t('filePanel.saveFailed'));
    } finally {
      // A save that is no longer the current one must not report the panel idle:
      // it would re-enable Save under a newer write and let an older body land last.
      if (seq === saveSeqRef.current) setSavingFile(null);
    }
  }, [selectedFile, savingFile, workspaceId, editContent, writeFileFn, setFileContent, t]);

  const handleCancelEdit = useCallback(() => {
    if (hasUnsavedChanges) {
      if (!window.confirm(t('filePanel.discardChanges'))) return;
    }
    setIsEditing(false);
    setEditContent(null);
    setShowDiff(false);
    setOriginalContent(null);
    setSaveError(null);
  }, [hasUnsavedChanges, t]);

  useEffect(() => {
    if (!isEditing) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (editContent !== null && editContent !== fileContent) {
          handleSave();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isEditing, editContent, fileContent, handleSave]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  return {
    isEditing,
    setIsEditing,
    editContent,
    setEditContent,
    isSaving,
    saveError,
    setSaveError,
    showDiff,
    setShowDiff,
    originalContent,
    setOriginalContent,
    editorRef,
    canUndo,
    setCanUndo,
    canRedo,
    setCanRedo,
    handleUndoRedoChange,
    hasUnsavedChanges,
    handleStartEdit,
    handleEditorChange,
    handleSave,
    handleCancelEdit,
  };
}
