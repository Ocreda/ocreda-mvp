CREATE TABLE IF NOT EXISTS note_canvas_positions (
  user_id uuid NOT NULL,
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  x double precision NOT NULL DEFAULT 0,
  y double precision NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, note_id)
);

ALTER TABLE note_canvas_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_canvas_positions" ON note_canvas_positions FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_canvas_positions" ON note_canvas_positions FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_canvas_positions" ON note_canvas_positions FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_canvas_positions" ON note_canvas_positions FOR DELETE
  TO authenticated USING (auth.uid() = user_id);
