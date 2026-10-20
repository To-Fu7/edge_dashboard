// known_faces — the roster shared by every camera with FACE_ENABLED=true.
import { v4 as uuidv4 } from 'uuid';
import { query } from './db';

export interface KnownFace {
  id: string;
  person_name: string;
  variant_type: string;
  source_photo_path: string | null;
  created_at: string;
}

export async function insertKnownFace(
  personName: string,
  embedding: number[],
  variantType: string,
  sourcePhotoPath: string | null,
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO known_faces (id, person_name, embedding, source_photo_path, variant_type)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, personName, embedding, sourcePhotoPath, variantType],
  );
  return id;
}

export async function listKnownFaces(): Promise<KnownFace[]> {
  return query<KnownFace>(
    `SELECT id, person_name, variant_type, source_photo_path, created_at
     FROM known_faces ORDER BY person_name, created_at`,
  );
}

export async function deleteKnownFacesByName(personName: string): Promise<number> {
  const rows = await query<{ id: string }>('DELETE FROM known_faces WHERE person_name = $1 RETURNING id', [personName]);
  return rows.length;
}
