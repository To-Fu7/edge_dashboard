// Server-side face-photo augmentation for enrollment: generates a set of
// variants from one uploaded photo so matching at runtime is more robust to
// real-world CCTV conditions than a single embedding would be. Mirrors the
// Python-side design: each variant gets its own known_faces row, matching
// takes the best similarity across all rows for a person, not an average.
//
// Variant rationale (each targets a specific real-world mismatch between a
// clean enrollment photo and what a CCTV camera actually captures):
//   flip                mirrored framing (subject not always facing the same way)
//   contrast up/down    exposure differences between the enrollment photo and camera
//   brightness up/down  distinct from contrast — flat light-level shift, not gain
//   rotate left/right   camera mounting tilt (CCTV is rarely perfectly level)
//   grayscale           night/IR mode — many CCTV setups switch to IR at night,
//                       producing a monochrome image with no color information at all
//   blur                motion blur / RTSP compression softness at lower bitrates
//   skew                off-angle viewing (e.g. a ceiling-mounted camera looking down)
import sharp from 'sharp';

export interface FaceVariant {
  variantType: 'original' | 'flip' | 'contrast' | 'brightness' | 'rotate' | 'grayscale' | 'blur' | 'skew';
  buffer: Buffer;
}

export async function generateFaceVariants(input: Buffer): Promise<FaceVariant[]> {
  const base = sharp(input).rotate(); // auto-orient from EXIF before deriving variants
  const bg = { background: '#000000' } as const;

  const [
    original, flip,
    contrastUp, contrastDown,
    brightnessUp, brightnessDown,
    rotateLeft, rotateRight,
    grayscale, blur, skew,
  ] = await Promise.all([
    base.clone().jpeg().toBuffer(),
    base.clone().flop().jpeg().toBuffer(),
    base.clone().linear(1.3, -20).jpeg().toBuffer(),
    base.clone().linear(0.7, 20).jpeg().toBuffer(),
    base.clone().modulate({ brightness: 1.35 }).jpeg().toBuffer(),
    base.clone().modulate({ brightness: 0.65 }).jpeg().toBuffer(),
    base.clone().rotate(12, bg).jpeg().toBuffer(),
    base.clone().rotate(-12, bg).jpeg().toBuffer(),
    base.clone().grayscale().jpeg().toBuffer(),
    base.clone().blur(1.5).jpeg().toBuffer(),
    base.clone().affine([1, 0.15, 0, 1], bg).jpeg().toBuffer(),
  ]);

  return [
    { variantType: 'original', buffer: original },
    { variantType: 'flip', buffer: flip },
    { variantType: 'contrast', buffer: contrastUp },
    { variantType: 'contrast', buffer: contrastDown },
    { variantType: 'brightness', buffer: brightnessUp },
    { variantType: 'brightness', buffer: brightnessDown },
    { variantType: 'rotate', buffer: rotateLeft },
    { variantType: 'rotate', buffer: rotateRight },
    { variantType: 'grayscale', buffer: grayscale },
    { variantType: 'blur', buffer: blur },
    { variantType: 'skew', buffer: skew },
  ];
}
