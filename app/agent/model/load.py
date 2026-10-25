from strands.models.bedrock import BedrockModel

# amazon.nova-pro-v1:0 is ACTIVE in us-west-2 and supports response streaming,
# but AWS only allows it through an inference profile. list-inference-profiles
# returned this system profile. Master, Planner, Booking, and Recovery all
# load it here, so none of them can fall back to the blocked Claude model.
NOVA_PRO_INFERENCE_PROFILE = "us.amazon.nova-pro-v1:0"


def load_model() -> BedrockModel:
    """Get the shared Bedrock model client using the runtime IAM role."""
    return BedrockModel(model_id=NOVA_PRO_INFERENCE_PROFILE)
