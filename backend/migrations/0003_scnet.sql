-- SCNet XL IHF replaces htdemucs_ft as the high quality model. New jobs can no longer use
-- htdemucs_ft (enforced in the API), but songs processed with it keep the value.
ALTER TABLE songs DROP CONSTRAINT songs_model_check;
ALTER TABLE songs ADD CONSTRAINT songs_model_check
    CHECK (model IN ('htdemucs', 'htdemucs_ft', 'scnet_xl_ihf'));
