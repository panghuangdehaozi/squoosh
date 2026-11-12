import { encoderMap, EncoderState, EncoderType } from '../feature-meta';

export function supportsTransparency(type: EncoderType): boolean {
  return type === 'browserPNG' || type === 'webP' || type === 'oxiPNG';
}

export function ensureTransparentEncoder(encoder: EncoderState): EncoderState {
  if (supportsTransparency(encoder.type)) return encoder;
  return {
    type: 'browserPNG',
    options: { ...encoderMap.browserPNG.meta.defaultOptions },
  };
}
