/*
  # Fix avatar storage SELECT policy

  ## Problem
  The existing "Anyone can read avatars" SELECT policy on storage.objects allows
  unauthenticated clients to list ALL files in the avatars bucket, which exposes
  more data than intended. Public buckets serve objects via URL without needing
  a SELECT policy — the policy is only needed to control row-level access via
  the storage API (e.g., listing).

  ## Changes
  - Drop the overly broad SELECT policy that allows anyone to list all avatars
  - Add a scoped SELECT policy so users can only read files within their own
    folder (user_id prefix), preventing cross-user enumeration

  ## Security Impact
  - Public object URLs continue to work (served by the CDN, unaffected by RLS)
  - Listing/querying storage.objects is now restricted to a user's own files
*/

DROP POLICY IF EXISTS "Anyone can read avatars" ON storage.objects;

CREATE POLICY "Users can read their own avatar"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = (auth.uid())::text
  );
