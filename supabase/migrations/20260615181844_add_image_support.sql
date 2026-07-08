-- Create the note-images storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'note-images',
  'note-images',
  true,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated and anon users to upload note images
CREATE POLICY "allow note image uploads"
  ON storage.objects FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'note-images');

-- Allow anyone to read note images (public bucket)
CREATE POLICY "allow note image reads"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'note-images');

-- Allow deletion of own note images
CREATE POLICY "allow note image deletes"
  ON storage.objects FOR DELETE
  TO anon, authenticated
  USING (bucket_id = 'note-images');

-- Add image_url column to notes table
ALTER TABLE notes ADD COLUMN IF NOT EXISTS image_url text;

-- Add image_url column to journal_entries table
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS image_url text;
