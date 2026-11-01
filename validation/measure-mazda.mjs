// The former model-2 adapter cannot validate the current model-3 core. Run the
// version-gated current protocol instead; a historical E0 comparison requires
// ENGINE_LAB_MAZDA_BASELINE and never changes model inputs. Use --smoke for a
// short, non-writing check of the frozen original rows. Run through lm-remote.
import './measure-mazda-model3.mjs';
