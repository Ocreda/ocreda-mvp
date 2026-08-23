'use client';

import { DragEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Check, Download, FileText, Loader as Loader2, X } from 'lucide-react';
import { extractDocumentText, type DocumentExtractionMethod } from '@/lib/notes-api';

export interface ImportNoteDraft {
  fileName: string;
  rawText: string;
  extractionMethod: 'exact' | DocumentExtractionMethod;
}

interface SelectedNoteFile extends ImportNoteDraft {
  key: string;
  size: number;
}

const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const LOCAL_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.xml']);
const DOCUMENT_MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'text/rtf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.bmp': 'image/bmp',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const SUPPORTED_EXTENSIONS = new Set([...LOCAL_TEXT_EXTENSIONS, ...Object.keys(DOCUMENT_MIME_TYPES)]);

function fileExtension(file: File): string {
  const dot = file.name.lastIndexOf('.');
  return dot === -1 ? '' : file.name.slice(dot).toLowerCase();
}

function hasSupportedExtension(file: File): boolean {
  return SUPPORTED_EXTENSIONS.has(fileExtension(file));
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export default function NoteImporter({
  onImport,
  importError,
}: {
  onImport: (notes: ImportNoteDraft[]) => Promise<void>;
  importError?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFiles, setSelectedFiles] = useState<SelectedNoteFile[]>([]);
  const [reading, setReading] = useState(false);
  const [readingProgress, setReadingProgress] = useState<{ current: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [selectionError, setSelectionError] = useState('');
  const [importing, setImporting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    if (!successMessage) return;
    const timeout = window.setTimeout(() => setSuccessMessage(''), 3500);
    return () => window.clearTimeout(timeout);
  }, [successMessage]);

  const addFiles = async (fileList: FileList | File[]) => {
    if (reading) return;
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    setSelectionError('');
    setSuccessMessage('');
    const unsupported = incoming.filter((file) => !hasSupportedExtension(file));
    const oversized = incoming.filter((file) => file.size > MAX_FILE_BYTES);
    const supported = incoming.filter(
      (file) => hasSupportedExtension(file) && file.size <= MAX_FILE_BYTES
    );

    if (unsupported.length > 0 || oversized.length > 0) {
      if (unsupported.length === 1 && oversized.length === 0) {
        setSelectionError('This file type isn\'t supported yet.');
      } else if (oversized.length === 1 && unsupported.length === 0) {
        setSelectionError('This file is too large. Choose a file smaller than 10 MB.');
      } else {
        setSelectionError('Some files could not be added. Use supported files smaller than 10 MB.');
      }
    }

    if (supported.length === 0) return;

    const existingKeys = new Set(selectedFiles.map((file) => file.key));
    const uniqueFiles = supported.filter((file) => !existingKeys.has(fileKey(file)));
    if (selectedFiles.length + uniqueFiles.length > MAX_FILES) {
      setSelectionError(`You can import up to ${MAX_FILES.toLocaleString()} notes at once.`);
      return;
    }

    const totalBytes = selectedFiles.reduce((total, file) => total + file.size, 0) +
      uniqueFiles.reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      setSelectionError('This selection is over 100 MB. Import it in smaller groups.');
      return;
    }

    setReading(true);
    try {
      const readable: SelectedNoteFile[] = [];
      const failures: Array<{ fileName: string; reason: string }> = [];
      for (let index = 0; index < uniqueFiles.length; index += 1) {
        const file = uniqueFiles[index];
        const extension = fileExtension(file);
        setReadingProgress({ current: index + 1, total: uniqueFiles.length });
        try {
          if (LOCAL_TEXT_EXTENSIONS.has(extension)) {
            const rawText = await file.text();
            if (!rawText.trim()) throw new Error('This file doesn\'t contain any readable text.');
            readable.push({
              key: fileKey(file),
              fileName: file.name,
              size: file.size,
              rawText,
              extractionMethod: 'exact',
            });
          } else {
            const extracted = await extractDocumentText(file, DOCUMENT_MIME_TYPES[extension]);
            readable.push({
              key: fileKey(file),
              fileName: file.name,
              size: file.size,
              rawText: extracted.text,
              extractionMethod: extracted.extractionMethod,
            });
          }
        } catch (error) {
          if (process.env.NODE_ENV !== 'production') console.error(`Could not process ${file.name}:`, error);
          const reason = error instanceof Error ? error.message : 'We couldn\'t read this document. Try another file or export it as PDF.';
          failures.push({ fileName: file.name, reason });
        }
      }

      setSelectedFiles((current) => [...current, ...readable]);
      if (failures.length > 0) {
        setSelectionError(
          failures.length === 1
            ? failures[0].reason
            : `We couldn\'t process ${failures.length} documents. Please try them again separately.`
        );
      }
    } finally {
      setReading(false);
      setReadingProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openFilePicker = () => fileInputRef.current?.click();
  const importSelectedFiles = async () => {
    if (reading || importing || selectedFiles.length === 0) return;
    setImporting(true);
    setSelectionError('');
    setSuccessMessage('');
    try {
      await onImport(selectedFiles.map(({ fileName, rawText, extractionMethod }) => ({
        fileName,
        rawText,
        extractionMethod,
      })));
      setSelectedFiles([]);
      setSuccessMessage('Your notes were imported successfully.');
    } catch {
      // The parent owns the safe import error copy displayed below.
    } finally {
      setImporting(false);
    }
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  };
  const handlePickerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFilePicker();
    }
  };

  return (
    <div className="w-full max-w-[424px]">
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.markdown,.csv,.json,.xml,.pdf,.doc,.docx,.odt,.rtf,.ppt,.pptx,.xls,.xlsx,.bmp,.jpg,.jpeg,.png,.webp"
        multiple
        className="sr-only"
        onChange={(event) => { if (event.target.files) void addFiles(event.target.files); }}
      />

      <div
        role="button"
        tabIndex={0}
        aria-label="Choose documents or note images to import"
        onClick={openFilePicker}
        onKeyDown={handlePickerKeyDown}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={handleDrop}
        aria-busy={reading}
        className={`min-h-[280px] cursor-pointer overflow-hidden rounded-[20px] border border-dashed text-center outline-none transition-colors focus:ring-2 focus:ring-primary/30 sm:min-h-[338px] ${
          dragging ? 'border-primary bg-primary/[0.06]' : 'border-primary/85 bg-card hover:bg-primary/[0.025]'
        }`}
      >
        <div className="flex min-h-[278px] w-full flex-col items-center rounded-[19px] bg-transparent px-5 py-7 sm:min-h-[336px] sm:px-8 sm:py-8">
          <h2 className="text-base font-semibold sm:text-[17px]">Import your notes</h2>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">Drag and drop your notes</p>

          <div className="mt-10 flex h-14 w-14 items-center justify-center text-primary sm:mt-14 sm:h-16 sm:w-16">
            {reading ? <Loader2 className="h-10 w-10 animate-spin" /> : selectedFiles.length > 0 ? (
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="h-6 w-6" />
              </span>
            ) : <Download className="h-14 w-14 stroke-[1.35]" />}
          </div>

          <div className="mt-auto">
            {readingProgress ? (
              <p className="text-xs text-muted-foreground">
                Processing document {readingProgress.current} of {readingProgress.total}…
              </p>
            ) : selectedFiles.length > 0 ? (
              <div>
                <p className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <FileText className="h-4 w-4 text-primary" />
                  {selectedFiles.length.toLocaleString()} note{selectedFiles.length === 1 ? '' : 's'} ready
                </p>
                {selectedFiles.some((file) => file.extractionMethod !== 'exact') && (
                  <p className="mt-1 text-xs text-muted-foreground">OCR text ready for review</p>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground sm:text-xs">TXT, MD, PDF, Word, Office, and note images</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-2 pl-5">
        <button
          type="button"
          onClick={() => void importSelectedFiles()}
          disabled={reading || importing || selectedFiles.length === 0 || selectedFiles.some((file) => !file.rawText.trim())}
          className="flex h-8 w-[136px] items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
        >
          {importing
            ? 'Importing…'
            : selectedFiles.length > 0
            ? `Import ${selectedFiles.length.toLocaleString()} note${selectedFiles.length === 1 ? '' : 's'}`
            : 'Import'}
        </button>
        {selectedFiles.length > 0 && (
          <button
            type="button"
            onClick={() => { setSelectedFiles([]); setSelectionError(''); }}
            aria-label="Clear selected notes"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div aria-live="polite" aria-atomic="true">
      {(selectionError || importError) && (
        <div role="alert" className="mt-3 break-words rounded-lg border border-destructive/20 bg-destructive/[0.05] px-3 py-2.5 text-left text-xs leading-relaxed text-destructive sm:text-sm">
          {importError || selectionError}
        </div>
      )}
      {successMessage && !selectionError && !importError && (
        <p className="mt-3 px-1 text-left text-xs text-primary sm:text-sm">{successMessage}</p>
      )}
      </div>

      {selectedFiles.length > 0 && (
        <details className="mt-3 rounded-lg border border-border bg-background/30 text-left">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
            Review extracted text
          </summary>
          <div className="max-h-72 space-y-2 overflow-y-auto border-t border-border p-2 scrollbar-thin">
            {selectedFiles.map((file) => (
              <details key={file.key} className="rounded-md border border-border bg-card">
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                  <span className="break-all">{file.fileName}</span>
                  <span className="ml-2 font-normal text-muted-foreground">
                    {file.extractionMethod === 'ocr' ? 'OCR' : file.extractionMethod === 'document' ? 'extracted' : 'exact'}
                  </span>
                </summary>
                <div className="border-t border-border p-2">
                  <textarea
                    value={file.rawText}
                    onChange={(event) => {
                      const rawText = event.target.value;
                      setSelectedFiles((current) => current.map((item) => item.key === file.key ? { ...item, rawText } : item));
                    }}
                    aria-label={`Extracted text from ${file.fileName}`}
                    rows={8}
                    className="w-full resize-y rounded-md border border-border bg-background p-2 text-xs leading-relaxed focus:border-primary/50 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedFiles((current) => current.filter((item) => item.key !== file.key))}
                    className="mt-2 text-xs text-destructive hover:underline"
                  >
                    Remove file
                  </button>
                </div>
              </details>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
